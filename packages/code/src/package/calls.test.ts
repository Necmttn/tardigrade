import fc from "fast-check"
import { KeyValueStore } from "effect/unstable/persistence"
import { actorFromProjections, createActorReconciler } from "@clavia/tardigrade-core/runtime"
import { EventLog } from "@clavia/tardigrade-core/log"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eventAt, eventPositionOf, type Event } from "@clavia/tardigrade-core/event"
import { replayProjection, replayState } from "@clavia/tardigrade-core/projection"
import { machineOf, transitionProjectionOf } from "../../../core/src/component/runtime"
import type { PackageDefinition } from "./definition"
import { packageCalls } from "./calls"

const notes: PackageDefinition<never> = {
  name: "notes",
  description: "Notes",
  methods: { read: () => Effect.succeed("ok") }
}

const ref = (seq: number) => ({ seq, component: "code.dispatch", tag: "dispatch" })
const stamp = (seq: number, epoch: number) => ({ callId: `exec-${seq}.0`, executionRef: ref(seq), ordinal: 0, turn: "run-1", ...(epoch === 0 ? {} : { epoch }) })

const resumed = (terminal: "TurnCompleted" | "TurnCancelled", order: "before" | "after"): ReadonlyArray<Event> => {
  const completion: Event = { type: terminal, turn: "run-1" }
  const resume: Event = { type: "TurnResumed", turn: "run-1", failedEpoch: 0, epoch: 1 }
  return [
    { type: "MessageReceived", id: "run-1", text: "question" },
    { type: "PackageCalled", name: "notes.read", arguments: { epoch: 0 }, ...stamp(1, 0) },
    { type: "TurnFailed", turn: "run-1" },
    ...(order === "before" ? [completion, resume] : [resume, completion]),
    { type: "PackageCalled", name: "notes.read", arguments: { epoch: 1 }, ...stamp(2, 1) }
  ].map((event, index) => eventAt(event, index + 1))
}

const servedAfter = (events: ReadonlyArray<Event>) => replayProjection(machineOf(packageCalls(notes)), events).view

describe("package calls", () => {
  test.each([
    ["TurnCompleted", "before"],
    ["TurnCompleted", "after"],
    ["TurnCancelled", "before"],
    ["TurnCancelled", "after"]
  ] as const)("a late %s %s resume preserves the turn's calls", (terminal, order) => {
    const view = servedAfter(resumed(terminal, order))
    expect(view.calls.map(call => call.arguments)).toEqual([{ epoch: 0 }, { epoch: 1 }])
    expect(view.pendingCalls.map(call => call.arguments)).toEqual([{ epoch: 1 }])
  })

  test.each(["TurnCompleted", "TurnCancelled"] as const)("%s in the active epoch drops the turn", (terminal) => {
    const completed = [
      ...resumed(terminal, "after"),
      { type: "PackageReturned", result: "ok", ...stamp(2, 1) },
      { type: terminal, turn: "run-1", epoch: 1 }
    ].map((event, index) => eventAt(event, index + 1))
    const view = servedAfter(completed)
    expect(view.calls).toEqual([])
    expect(view.pendingCalls).toEqual([])
  })
})


test("package checkpoints preserve work identity across every replay tail", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 12 }), completed => {
    const log: ReadonlyArray<Event> = completed.flatMap((done, index) => [
      { type: "Unrelated" },
      { type: "PackageCalled", name: "notes.read", callId: `call-${index}`, arguments: { index } },
      ...(done ? [{ type: "PackageReturned", callId: `call-${index}`, result: "ok" }] : [])
    ]).map((event, index) => eventAt(event, index + 1))
    const original = machineOf(packageCalls(notes))
    const observe = (machine: typeof original, state: unknown) => ({
      checkpoint: machine.checkpoint!.encode(state),
      view: machine.output(state).view,
      work: machine.output(state).transitions.map(work => ({ key: work.key, invocation: work.invocation }))
    })
    const expected = Array.from({ length: log.length + 1 }, (_, end) => observe(original, replayState(original, log.slice(0, end))))
    for (let cut = 0; cut <= log.length; cut++) {
      const fresh = machineOf(packageCalls({ ...notes, methods: { read: () => Effect.die("replay must not execute") } }))
      let restored = fresh.checkpoint!.decode(JSON.parse(JSON.stringify(expected[cut]!.checkpoint)))
      for (let end = cut; end <= log.length; end++) {
        expect(observe(fresh, restored)).toEqual(expected[end]!)
        if (end < log.length) restored = fresh.step(restored, log[end]!)
      }
    }
  }))
})

test("the reconciler executes restored package work and commits its existing transitionRef", async () => {
  const events: Event[] = [
    { type: "MessageReceived", id: "turn", text: "read" },
    { type: "PackageCalled", name: "notes.read", callId: "call", arguments: { text: "shoes" }, turn: "turn" },
    { type: "Unrelated" }
  ]
  const original = createActorReconciler(actorFromProjections({
    transitions: [transitionProjectionOf(packageCalls({ ...notes, methods: { read: () => Effect.die("old implementation") } }))],
    keyOf: () => undefined
  }))
  const tail = events.pop()!
  let allowFullRead = true
  const reads: number[] = []
  const log = Layer.succeed(EventLog, {
    read: Effect.sync(() => { if (!allowFullRead) throw new Error("restore read the prefix"); return [...events] }),
    head: Effect.sync(() => events.length),
    readFrom: mark => Effect.sync(() => { reads.push(mark); return events.slice(mark) }),
    append: batch => Effect.sync(() => { events.push(...batch) })
  })
  const saved = JSON.parse(JSON.stringify(await Effect.runPromise(original.checkpoint.pipe(Effect.provide(Layer.merge(log, KeyValueStore.layerMemory))))))
  expect(saved.watermark).toBe(2)
  events.push(tail)
  allowFullRead = false
  let executions = 0
  const steps: number[] = []
  const projection = transitionProjectionOf(packageCalls({ ...notes, methods: { read: args => Effect.sync(() => { executions++; return args }) } }))
  const actor = actorFromProjections({
    transitions: [{ ...projection,
      initial: () => { throw new Error("restore initialized the component") },
      step: (state, event) => { steps.push(eventPositionOf(event)!); return projection.step(state, event) }
    }],
    keyOf: () => undefined
  })
  const restored = createActorReconciler(actor, { checkpoint: saved })
  const services = Layer.merge(log, KeyValueStore.layerMemory)
  await Effect.runPromise(restored.checkpoint.pipe(Effect.provide(services)))
  expect(steps).toEqual([3])
  allowFullRead = true
  await Effect.runPromise(restored.settle.pipe(Effect.provide(services)))
  expect(reads[0]).toBe(2)
  expect(steps).toEqual([3, 4])
  expect(executions).toBe(1)
  expect(events.map(event => event.type)).toEqual(["MessageReceived", "PackageCalled", "Unrelated", "PackageReturned"])
  expect(events.at(-1)).toMatchObject({
    type: "PackageReturned", callId: "call", result: { text: "shoes" },
    transitionRef: { seq: 2, component: "package.notes", tag: "invoke" },
    invocationRef: { method: "message", id: "turn", epoch: 0 }
  })
  const completed = JSON.parse(JSON.stringify(await Effect.runPromise(restored.checkpoint.pipe(Effect.provide(services)))))
  const resumed = createActorReconciler(actor, { checkpoint: completed })
  await Effect.runPromise(resumed.settle.pipe(Effect.provide(services)))
  for (const checkpoint of [{ ...saved, watermark: 999 }, { ...saved, projections: [] }, { ...saved, version: 2 }, { ...saved, projections: [{ ...saved.projections[0], component: "other" }] }]) {
    await expect(Effect.runPromise(createActorReconciler(actor, { checkpoint }).settle.pipe(Effect.provide(services)))).rejects.toThrow()
  }
  expect(executions).toBe(1)
})

test("package checkpoints reject executable request data", () => {
  const machine = machineOf(packageCalls(notes))
  const state = replayState(machine, [{ type: "PackageCalled", name: "notes.read", callId: "call", arguments: { callback: () => "hidden" } }])
  expect(() => machine.checkpoint!.encode(state)).toThrow()
})


test("actor startup checkpoints plus every tail equal full package replay", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 7 }), async completed => {
    const events: Event[] = completed.flatMap((done, index) => [
      { type: "PackageCalled", name: "notes.read", callId: `call-${index}`, arguments: { index } },
      ...(done ? [{ type: "PackageReturned", callId: `call-${index}`, result: "ok", transitionRef: { seq: 1 + completed.slice(0, index).reduce((sum, item) => sum + 1 + Number(item), 0), component: "package.notes", tag: "invoke" } }] : [])
    ])
    const make = () => actorFromProjections({ transitions: [transitionProjectionOf(packageCalls(notes))], keyOf: () => undefined })
    const layer = (log: Event[], tailOnly = false) => Layer.succeed(EventLog, {
      read: tailOnly ? Effect.die("checkpoint startup read full log") : Effect.succeed(log),
      head: Effect.succeed(log.length), readFrom: mark => Effect.succeed(log.slice(mark)),
      append: () => Effect.die("capturing a checkpoint must not execute")
    })
    const full = await Effect.runPromise(createActorReconciler(make()).checkpoint.pipe(Effect.provide(Layer.merge(layer(events), KeyValueStore.layerMemory))))
    for (let cut = 0; cut <= events.length; cut++) {
      const prefix = await Effect.runPromise(createActorReconciler(make()).checkpoint.pipe(Effect.provide(Layer.merge(layer(events.slice(0, cut)), KeyValueStore.layerMemory))))
      const checkpoint = JSON.parse(JSON.stringify(prefix))
      const recovered = await Effect.runPromise(createActorReconciler(make(), { checkpoint }).checkpoint.pipe(Effect.provide(Layer.merge(layer(events, true), KeyValueStore.layerMemory))))
      expect(recovered).toEqual(full)
    }
  }))
})
