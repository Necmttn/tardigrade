import type { ActorRecovery } from "@clavia/tardigrade-core/runtime"
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { actor, component } from "@clavia/tardigrade-core/actor"
import { PositionedEvent, type Event, eventAt } from "@clavia/tardigrade-core/event"
import { createBunHost, bunThreadDatabasePath } from "./host"
import { checkpointAgent } from "@clavia/tardigrade-agent/testing/checkpoint"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { testModelData } from "@clavia/tardigrade-agent/testing/model"

describe("SQLite persistence", () => {
  const worker = (initialized: () => void, reduced: () => void) => actor({
    name: "worker", methods: {}, components: [component<ReadonlyArray<Event>, number>({
      name: "echo", checkpoint: { version: "1", schema: Schema.Array(PositionedEvent) },
      initial: (): ReadonlyArray<Event> => { initialized(); return [] },
      step: (state, event) => {
        reduced()
        return event.type === "MessageReceived" ? [...state, event]
          : event.type === "Done" ? state.filter((request) => request.id !== event.id) : state
      },
      output: (state, _children, _data, context) => ({ view: state.length, transitions: state.map((event) =>
        context.transition(event).intent("reply", { type: "Done", id: event.id, at: 10 })) })
    })]
  })

  test("SQLite recovery loads compiled state, reduces the crash tail, and replaces corrupt or incompatible checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tardigrade-state-checkpoint-"))
    const database = join(directory, "actor.sqlite")
    let initialized = 0
    let reduced = 0
    const reports: Array<ActorRecovery> = []
    const open = (version = "1") => {
      const definition = worker(() => { initialized++ }, () => { reduced++ })
      return createBunHost({
      database, actorName: "worker", actorInstance: "default", workspaceSql: false,
      actorFor: () => definition,
      checkpoint: { version, onRecovery: (_thread, recovery) => { reports.push(recovery) } }
      })
    }
    try {
      const first = await open()
      try {
        await first.allocate({ kind: "root", coordinate: { actor: "worker", instance: "default", thread: "root" } })
        await first.commitRoot(first.self("root"), { type: "MessageReceived", id: "first", at: 1 })
        await first.drive()
      } finally { await first.close() }
      const file = bunThreadDatabasePath(database, "root")
      const db = new Database(file)
      const saved = db.query<{ checkpoint: string; stream: string }, []>("SELECT checkpoint, stream FROM actor_checkpoint").get()!
      const watermark = (JSON.parse(saved.checkpoint) as { watermark: number }).watermark
      db.run("INSERT INTO events (seq, event) VALUES (?, ?)", [watermark + 1, JSON.stringify({ type: "MessageReceived", id: "tail", at: 2 })])
      db.close()
      initialized = 0; reduced = 0; reports.length = 0
      const resumed = await open()
      try {
        await resumed.recover()
        expect(reports).toContainEqual({ kind: "checkpoint", watermark })
        expect(initialized).toBe(0)
        expect(reduced).toBe(2)
        expect((await resumed.read("root")).filter((event) => event.type === "Done").map((event) => event.id)).toEqual(["first", "tail"])
      } finally { await resumed.close() }
      for (const corruption of ["{broken", "version"]) {
        if (corruption !== "version") {
          const db = new Database(file)
          db.run("UPDATE actor_checkpoint SET checkpoint = ?", [corruption])
          db.close()
        }
        initialized = 0; reports.length = 0
        const fallback = await open(corruption === "version" ? "2" : "1")
        try {
          await fallback.recover()
          expect(initialized).toBeGreaterThan(0)
          expect(reports.some((report) => report.kind === "replay" && report.reason !== undefined)).toBe(true)
          expect((await fallback.read("root")).filter((event) => event.type === "Done")).toHaveLength(2)
        } finally { await fallback.close() }
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 20000)
})

describe("complete agent", () => {
  test("a complete agent survives every control-state cut and a persisted restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "full-agent-checkpoint-"))
    try {
      for (const mode of ["native", "code"] as const) {
        let tools = 0
        let models = 0
        const fixture = () => checkpointAgent({ mode, callsPerTurn: 2, limit: 1, onTool: () => { tools++ }, onModel: () => { models++ } })
        const open = async () => {
          const { definition, layers } = fixture()
          return createBunHost({ database: join(directory, `${mode}.sqlite`), actorName: definition.name, actorFor: () => definition, layersFor: () => layers,
            checkpoint: { version: "1" } })
        }
        const first = await open()
        let history
        try {
          await first.allocate({ kind: "root", coordinate: { actor: "checkpoint-agent", instance: "default", thread: "root" } })
          await first.commitRoot(first.self("root"), { type: "MessageReceived", id: "turn", text: "echo", at: 1 })
          await first.drive()
          history = await first.read("root")
          expect(history.some((event) => event.type === "TurnCompleted")).toBe(true)
        } finally { await first.close() }
        const original = actorRuntimeOf(fixture().definition).projection!
        let prefix = original.initial(testModelData)
        for (let cut = 0; cut <= history.length; cut++) {
          const restored = actorRuntimeOf(fixture().definition).projection!
          let resumed = restored.checkpoint!.decode(JSON.parse(JSON.stringify(original.checkpoint!.encode(prefix))), testModelData)
          let replayed = prefix
          for (let i = cut; i < history.length; i++) {
            const event = eventAt(history[i]!, i + 1)
            resumed = restored.step(resumed, event)
            replayed = original.step(replayed, event)
            expect(restored.checkpoint!.encode(resumed)).toEqual(original.checkpoint!.encode(replayed))
            expect(restored.output(resumed).continuations.map((work) => work.key)).toEqual(original.output(replayed).continuations.map((work) => work.key))
          }
          if (cut < history.length) prefix = original.step(prefix, eventAt(history[cut]!, cut + 1))
        }
        const before = { tools, models }
        const reopened = await open()
        try {
          await reopened.recover()
          expect({ tools, models }).toEqual(before)
          expect(await reopened.read("root")).toEqual(history)
          await reopened.commitRoot(reopened.self("root"), { type: "MessageReceived", id: "next", text: "again", at: 2 })
          await reopened.drive()
          expect((await reopened.read("root")).some((event) => event.type === "TurnCompleted" && event.turn === "next")).toBe(true)
        } finally { await reopened.close() }
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30000)
})
