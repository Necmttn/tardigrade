import type { ActorRecovery } from "@clavia/tardigrade-core/runtime"
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { actor, component } from "@clavia/tardigrade-core/actor"
import { PositionedEvent, type Event } from "@clavia/tardigrade-core/event"
import { createBunHost, bunThreadDatabasePath } from "./host"

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
