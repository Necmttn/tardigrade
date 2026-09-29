import fc from "fast-check"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { component } from "../component/machine"
import { transitionProjectionOf } from "../component/runtime"
import { eventPositionOf, type Event, eventAt } from "../event"
import { EventLog } from "../log"
import { intent } from "../intent"
import { eraseTransitionProjection, transitionProjection } from "../transition"
import { actorFromProjections, createActorReconciler, type ActorCheckpoint } from "./index"
import { actor, actorMethod, durableInputProjection } from "../actor"
import { actorRuntimeOf } from "./actor"
import { replayState } from "../projection/projection"
import { cancellationRequested } from "../interaction/cancellation"

describe("reconciler recovery", () => {
  const identity = { actor: "worker", version: "1", stream: "thread-1" }
  const State = Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Int }))
  const makeActor = (ready: () => boolean, initialize = () => {}, reduced = () => {}) => actorFromProjections({
    transitions: [eraseTransitionProjection(transitionProjection({
      checkpoint: { encode: Schema.encodeSync(State), decode: (state) => Schema.decodeUnknownSync(State)(state) },
      initial: (): typeof State.Type => { initialize(); return [] },
      step: (state: typeof State.Type, event: Event) => {
        reduced()
        return event.type === "Start" ? [...state, { id: String(event.id), position: eventPositionOf(event)! }] : state
      },
      output: (state: typeof State.Type) => state.map(({ id, position }) => intent({
        key: id,
        input: undefined,
        events: () => ready() ? [{ type: "Done", id, position }] : []
      }))
    }))],
    keyOf: (event) => event.type === "Done" ? String(event.id) : undefined
  })
  const memory = (seed: ReadonlyArray<Event>) => {
    const events = [...seed]
    let reads = 0
    const marks: Array<number> = []
    return {
      events, marks, reads: () => reads,
      layer: Layer.succeed(EventLog, {
        append: (batch: ReadonlyArray<Event>) => Effect.sync(() => { events.push(...batch) }),
        read: Effect.sync(() => { reads++; return [...events] }),
        head: Effect.sync(() => events.length),
        readFrom: (mark: number) => Effect.sync(() => { marks.push(mark); return events.slice(mark) })
      })
    }
  }
  const json = (checkpoint: ActorCheckpoint): unknown => JSON.parse(JSON.stringify(checkpoint))

  test("every checkpoint cut resumes the same work as full replay with no prefix reductions", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 16 }), async (completed) => {
      const history = completed.flatMap((done, index) => [
        { type: "Start", id: `job-${index}` },
        ...(done ? [{ type: "Done", id: `job-${index}` }] : [])
      ])
      for (let cut = 0; cut <= history.length; cut++) {
        const prefix = memory(history.slice(0, cut))
        const before = createActorReconciler(makeActor(() => false), { checkpoint: identity })
        await Effect.runPromise(before.settle.pipe(Effect.provide(prefix.layer)))
        const saved = json(before.checkpoint())
        const resumedLog = memory(history)
        let reductions = 0
        const resumed = createActorReconciler(makeActor(() => true, () => { throw new Error("restore initialized") }, () => { reductions++ }), {
          checkpoint: identity, restore: saved
        })
        await Effect.runPromise(resumed.settle.pipe(Effect.provide(resumedLog.layer)))
        const replayLog = memory(history)
        const replay = createActorReconciler(makeActor(() => true), { checkpoint: identity })
        await Effect.runPromise(replay.settle.pipe(Effect.provide(replayLog.layer)))
        expect(resumedLog.events).toEqual(replayLog.events)
        expect(resumed.checkpoint()).toEqual(replay.checkpoint())
        expect(resumed.isResting()).toBe(true)
        expect(resumed.recovery()).toEqual({ kind: "checkpoint", watermark: cut })
        expect(resumedLog.reads()).toBe(0)
        expect(resumedLog.marks[0]).toBe(cut)
        expect(reductions).toBe(resumedLog.events.length - cut)
        const again = createActorReconciler(makeActor(() => true), { checkpoint: identity, restore: json(resumed.checkpoint()) })
        await Effect.runPromise(again.settle.pipe(Effect.provide(resumedLog.layer)))
        expect(again.checkpoint()).toEqual(replay.checkpoint())
      }
    }))
  }, 30000)

  test("invalid candidates report fallback and replay from the beginning", async () => {
    const sourceLog = memory([{ type: "Start", id: "job" }])
    const source = createActorReconciler(makeActor(() => false), { checkpoint: identity })
    await Effect.runPromise(source.settle.pipe(Effect.provide(sourceLog.layer)))
    const saved = source.checkpoint()
    for (const restore of [null, {}, { ...saved, version: "2" }, { ...saved, actor: "other" },
      { ...saved, stream: "other" }, { ...saved, watermark: 2 }, { ...saved, watermark: -1 },
      { ...saved, projections: [] }, { ...saved, projections: [false] }]) {
      const log = memory(sourceLog.events)
      const recovered = createActorReconciler(makeActor(() => true), { checkpoint: identity, restore })
      await Effect.runPromise(recovered.settle.pipe(Effect.provide(log.layer)))
      expect(recovered.recovery().kind).toBe("replay")
      expect(recovered.recovery()).toHaveProperty("reason")
      expect(log.reads()).toBe(1)
      expect(log.events.at(-1)).toEqual({ type: "Done", id: "job", position: 1 })
    }
  })

  test("unsupported runtime state is rejected before checkpointing", () => {
    const plain = { initial: () => 0, step: () => 0, output: () => [] }
    expect(() => createActorReconciler(actorFromProjections({ transitions: [plain], keyOf: () => undefined }), { checkpoint: identity })).toThrow("every transition projection")
    expect(() => createActorReconciler(actorFromProjections({ transitions: [], keyOf: () => undefined, legacy: { cancellationOf: () => undefined } }), { checkpoint: identity })).toThrow("complete-log")
    const source = createActorReconciler(makeActor(() => false), { checkpoint: identity })
    expect(() => source.checkpoint()).toThrow("no synchronized state")
  })

  test("control, guards, and tracing restore together before tail execution", async () => {
    const build = () => {
      const guard = transitionProjection({
        checkpoint: { encode: Schema.encodeSync(Schema.Boolean), decode: (state) => Schema.decodeUnknownSync(Schema.Boolean)(state) },
        initial: () => false,
        step: (cleared: boolean, event: Event) => cleared || event.type === "Cleared",
        output: (cleared: boolean) => cleared ? [] : [intent({ key: "guard", input: undefined, events: () => [] })]
      })
      return actorFromProjections({
        transitions: [guard], guards: [guard], keyOf: () => undefined,
        control: {
          checkpoint: {
            encode: (state: unknown) => Schema.decodeUnknownSync(Schema.Int)(state),
            decode: (state) => Schema.decodeUnknownSync(Schema.Int)(state)
          },
          initial: () => 0,
          step: (state: unknown, event: Event) => Number(state) + (event.type === "Tick" ? 1 : 0),
          output: (state: unknown) => ({
            continuations: Number(state) > 0 ? [intent({ key: "control", input: undefined, events: () => [] })] : [],
            cancellationOf: () => undefined,
            suppresses: () => false,
            residuals: undefined
          })
        }
      })
    }
    const log = memory([{ type: "Tick", traceparent: "00-trace-parent-01" }])
    const first = createActorReconciler(build(), { checkpoint: identity })
    await Effect.runPromise(first.settle.pipe(Effect.provide(log.layer)))
    const saved = json(first.checkpoint())
    log.events.push({ type: "Cleared" }, { type: "Tick" })
    const restored = createActorReconciler(build(), { checkpoint: identity, restore: saved })
    await Effect.runPromise(restored.settle.pipe(Effect.provide(log.layer)))
    const full = createActorReconciler(build(), { checkpoint: identity })
    await Effect.runPromise(full.settle.pipe(Effect.provide(log.layer)))
    expect(restored.checkpoint()).toEqual(full.checkpoint())
    expect(restored.checkpoint().control).toBe(2)
    expect(restored.checkpoint().projections).toEqual([true])
    expect(restored.checkpoint().trigger).toEqual({ traceId: "trace", spanId: "parent" })
    expect(restored.isResting()).toBe(false)
  })

  test("a failed restored tail retries from the checkpoint without falling back", async () => {
    const log = memory([{ type: "Start", id: "job" }])
    const original = createActorReconciler(makeActor(() => false), { checkpoint: identity })
    await Effect.runPromise(original.settle.pipe(Effect.provide(log.layer)))
    const saved = json(original.checkpoint())
    log.events.push({ type: "Noise" })
    log.marks.length = 0
    let fails = true
    const restored = createActorReconciler(makeActor(() => false, () => { throw new Error("initialized") }, () => {
      if (fails) { fails = false; throw new Error("tail failed") }
    }), { checkpoint: identity, restore: saved })
    await expect(Effect.runPromise(restored.settle.pipe(Effect.provide(log.layer)))).rejects.toThrow("tail failed")
    expect(restored.checkpoint().watermark).toBe(1)
    await Effect.runPromise(restored.settle.pipe(Effect.provide(log.layer)))
    expect(restored.checkpoint().watermark).toBe(2)
    expect(restored.recovery()).toEqual({ kind: "checkpoint", watermark: 1 })
    expect(log.reads()).toBe(1)
    expect(log.marks.slice(0, 2)).toEqual([1, 1])
  })

  test("component adapters preserve codecs and bind fresh dependencies on restore", async () => {
    class Dependency extends Context.Service<Dependency, { readonly observe: (value: number) => void }>()("checkpoint-test/Dependency") {}
    const build = (initialize: () => number) => actorFromProjections({
      transitions: [transitionProjectionOf(component({
        name: "counter",
        dependencies: [Dependency],
        checkpoint: { version: "1", schema: Schema.Int },
        initial: initialize,
        step: (state) => state + 1,
        output: (state, _children, [dependency]) => {
          dependency.observe(state)
          return { view: state, transitions: [] }
        }
      }))],
      keyOf: () => undefined
    })
    const seen: Array<number> = []
    const log = memory([{ type: "Tick" }])
    const original = createActorReconciler(build(() => 0), { checkpoint: identity })
    await Effect.runPromise(original.settle.pipe(Effect.provide(log.layer), Effect.provideService(Dependency, { observe: () => {} })))
    const restored = createActorReconciler(build(() => { throw new Error("initialized") }), { checkpoint: identity, restore: json(original.checkpoint()) })
    log.events.push({ type: "Tick" })
    await Effect.runPromise(restored.settle.pipe(Effect.provide(log.layer), Effect.provideService(Dependency, { observe: (value) => { seen.push(value) } })))
    expect(restored.recovery()).toEqual({ kind: "checkpoint", watermark: 1 })
    expect(seen).toContain(1)
    expect(seen.at(-1)).toBe(2)
  })
})

describe("compiled control", () => {
  const MethodState = Schema.Record(Schema.String, Schema.Literals(["pending", "done", "cancelled"]))
  const definition = (initial = () => ({} as typeof MethodState.Type)) => actor({
    name: "worker",
    methods: { work: actorMethod({
      input: Schema.String, output: Schema.String,
      event: ({ invocation, input, at }) => ({ type: "Started", id: invocation.id, input, at }),
      cancellation: { event: ({ invocation }, at) => ({ type: "Cancelled", id: invocation.id, at }) },
      durableInput: {
        schema: Schema.Struct({ type: Schema.String }), matches: () => false, reject: () => ({ type: "Rejected" }),
        projection: durableInputProjection({
          checkpoint: { version: "1", schema: Schema.Int },
          initial: () => 0, step: (count: number) => count + 1, output: () => []
        })
      },
      projection: {
        checkpoint: { version: "1", schema: MethodState },
        initial,
        step: (state, event) => event.type === "Started" ? { ...state, [String(event.id)]: "pending" as const }
          : event.type === "Finished" ? { ...state, [String(event.id)]: "done" as const }
          : event.type === "Cancelled" ? { ...state, [String(event.id)]: "cancelled" as const } : state,
        output: (state) => ({ currentEpoch: () => 0, invocationState: ({ id }) => state[id] === "pending" ? { status: "pending" }
          : state[id] === "done" ? { status: "completed", output: "done" }
          : state[id] === "cancelled" ? { status: "cancelled", cause: "requested" } : undefined })
      }
    }) },
    components: [component({ name: "counter", checkpoint: { version: "1", schema: Schema.Int }, initial: () => 0,
      step: (count) => count + 1, output: (count) => ({ view: count, transitions: [] }) })]
  })
  const target = { actor: "worker", instance: "default", thread: "root" }
  const child = { actor: "worker", instance: "default", thread: "child" }
  const invocation = { method: "work", id: "job", epoch: 0 }
  const childInvocation = { method: "work", id: "child-job", epoch: 0 }

  const observe = (runtime: ReturnType<typeof actorRuntimeOf>, state: unknown) => {
    const output = runtime.projection!.output(state)
    return {
      saved: runtime.projection!.checkpoint!.encode(state),
      cancellation: output.cancellationOf(invocation), suppresses: output.suppresses(invocation),
      transitions: [...output.continuations, ...(output.residuals ?? [])].map((transition) => ({
        key: transition.key, kind: transition.kind, input: transition.kind === "effect" ? transition.input : undefined,
        events: transition.kind === "intent" ? transition.events(transition.input, 100) : undefined
      }))
    }
  }

  test("compiled control restores responses, deadlines, child cancellation, and method state at every cut", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (complete, detach, childSettled) => {
      const events: ReadonlyArray<Event> = [
        { type: "Started", id: "job", call: { invocation, deadlineAt: 50 }, link: { source: { provider: "test", id: "external" }, target }, at: 1 },
        { type: "InvocationLinked", parent: invocation, child: { invocation: childInvocation }, target: "worker:default:child", at: 2 },
        { type: "CallDispatched", id: "child-job", method: "work", target: "worker:default:child", reference: { target: child, invocation: childInvocation }, timeoutMs: 20, deadlineAt: 30, at: 3 },
        { type: "AlarmFired", scheduledFor: 30, at: 30 },
        cancellationRequested({ request: "stop", invocation, cause: "requested", at: 40 }),
        ...(childSettled ? [{ type: "ResponseReceived", method: "work", call: "child-job", from: "worker:default:child", reference: { target: child, invocation: childInvocation }, status: "completed", at: 41 }] : []),
        ...(complete ? [{ type: "Finished", id: "job", at: 42 }] : []),
        ...(detach ? [{ type: "InvocationDetached", direction: "incoming", reference: { target, invocation }, at: 43 }] : []),
        { type: "AlarmFired", scheduledFor: 50, at: 50 },
        { type: "ResponseDelivered", method: "work", call: "job", at: 60 }
      ]
      const original = actorRuntimeOf(definition())
      for (let cut = 0; cut <= events.length; cut++) {
        let full = replayState(original.projection!, events.slice(0, cut))
        const json: unknown = JSON.parse(JSON.stringify(original.projection!.checkpoint!.encode(full)))
        const fresh = actorRuntimeOf(definition(() => { throw new Error("initialized method") }))
        let restored = fresh.projection!.checkpoint!.decode(Schema.decodeUnknownSync(Schema.Json)(json), Context.empty())
        expect(observe(fresh, restored)).toEqual(observe(original, full))
        for (let i = cut; i < events.length; i++) {
          const event = eventAt(events[i]!, i + 1)
          full = original.projection!.step(full, event)
          restored = fresh.projection!.step(restored, event)
          expect(observe(fresh, restored)).toEqual(observe(original, full))
        }
        for (let i = 0; i < original.projections.length; i++) {
          const guard = original.projections[i]!
          const state = replayState(guard, events.slice(0, cut))
          const encoded = guard.checkpoint!.encode(state)
          const decoded = fresh.projections[i]!.checkpoint!.decode(JSON.parse(JSON.stringify(encoded)))
          expect(fresh.projections[i]!.checkpoint!.encode(decoded)).toEqual(encoded)
        }
      }
    }))
  })
})
