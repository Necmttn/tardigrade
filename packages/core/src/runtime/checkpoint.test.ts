import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import fc from "fast-check"
import { actor } from "../actor/definition"
import { actorMethod } from "../actor/method"
import { component } from "../component/machine"
import { RecordedEvent, eventAt, type Event } from "../event"
import { EventLog } from "../log"
import { replayState } from "../projection/projection"
import { bindTransitionContext } from "../transition/transition"
import { Router } from "../transport/router"
import { formatThreadAddress } from "../transport/endpoint"
import { actorRuntimeOf } from "./actor"
import { createActorReconciler, Self } from "./reconciler"

const self = { actor: "worker", instance: "main", thread: "root" }
const caller = { ...self, thread: "caller" }
const child = { ...self, thread: "child" }
const invocation = { method: "work", id: "job", epoch: 0 }
const childInvocation = { method: "work", id: "child-job", epoch: 0 }
const MethodState = Schema.toCodecJson(Schema.ReadonlyMap(Schema.String, Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("completed"), output: Schema.String }),
  Schema.Struct({ status: Schema.Literal("cancelled"), cause: Schema.Literals(["requested", "deadline"]) })
])))

const fixture = (options: { restoring?: boolean; version?: string; codec?: boolean; worker?: boolean } = {}) => {
  const initial = <T>(value: T): T => { if (options.restoring) throw new Error("checkpoint restore called initial"); return value }
  const work = actorMethod({
    input: Schema.String, output: Schema.String,
    event: ({ invocation, input, at }) => ({ type: "WorkStarted", id: invocation.id, input, at }),
    cancellation: { event: (request, at) => ({ type: "WorkCancelled", id: request.invocation.id, cause: request.cause, at }) },
    projection: {
      ...(options.codec === false ? {} : { state: { version: options.version ?? "1", schema: MethodState } }),
      initial: (): typeof MethodState.Type => initial(new Map()),
      step: (state, event) => {
        if (event.type === "WorkStarted") return new Map(state).set(String(event.id), { status: "pending" as const })
        if (event.type === "WorkCompleted") return new Map(state).set(String(event.id), { status: "completed" as const, output: String(event.result) })
        if (event.type === "WorkCancelled") return new Map(state).set(String(event.id), { status: "cancelled" as const, cause: event.cause === "deadline" ? "deadline" as const : "requested" as const })
        return state
      },
      output: state => ({ currentEpoch: () => 0, invocationState: invocation => state.get(invocation.id) })
    }
  })
  return actor({
    name: "worker", methods: { work },
    components: options.worker === false ? [] : [component({
      name: "worker.jobs", state: { version: "1", schema: Schema.toCodecJson(Schema.Array(RecordedEvent)) },
      initial: (): ReadonlyArray<Event> => initial([]),
      step: (state, event) => event.type === "WorkStarted" ? [...state, event]
        : ["WorkCompleted", "WorkCancelled"].includes(event.type) ? state.filter(owner => owner.id !== event.id) : state,
      output: state => ({ view: state.map(owner => owner.id), transitions: state.map(owner => bindTransitionContext(owner, "worker.jobs").effect("execute", {
        input: String(owner.input), act: input => Effect.succeed({ type: "WorkCompleted", id: owner.id, result: input })
      })) })
    })]
  })
}

const started = (): Event => ({ type: "WorkStarted", id: "job", input: "done", at: 1, call: { invocation, deadlineAt: 10 }, link: { source: caller, target: self } })
const cancellation = (): Event => ({ type: "CancellationRequested", request: "cancel", invocation, cause: "requested", at: 4 })
const linked = (): Event => ({ type: "InvocationLinked", parent: invocation, child: { invocation: childInvocation }, target: formatThreadAddress(child), lineage: { parent: self, depth: 1 }, at: 2 })
const dispatched = (): Event => ({ type: "CallDispatched", id: "child-job", method: "work", target: formatThreadAddress(child), reference: { target: child, invocation: childInvocation }, timeoutMs: 5, deadlineAt: 10, at: 3 })

test("full actor control checkpoints match replay across every cut and tail", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.integer({ min: 0, max: 2 }), fc.boolean(), (hasChild, cancels, terminal, detached, cancellationProgress, earlyCancellation) => {
    const cancelId = `cancel:${JSON.stringify(["cancel", formatThreadAddress(child), "work", "child-job", 0])}`
    const cancelRef = { target: child, invocation: { method: "$cancel", id: cancelId, epoch: 0 } }
    const log = [...(cancels && earlyCancellation ? [cancellation()] : []), started(), ...(hasChild ? [linked(), dispatched()] : []),
      ...(cancels && !earlyCancellation ? [cancellation()] : []),
      ...(hasChild && cancels && cancellationProgress > 0 ? [{ type: "CancellationDispatched", reference: cancelRef, request: cancelId, invocation: childInvocation, target: formatThreadAddress(child), timeoutMs: 5, deadlineAt: 10, at: 5 }] : []),
      ...(hasChild && cancels && cancellationProgress > 1 ? [{ type: "CallTimedOut", reference: cancelRef, method: "$cancel", call: cancelId, target: formatThreadAddress(child), timeoutMs: 5, deadlineAt: 10, at: 11 }] : []),
      { type: "AlarmFired", scheduledFor: 10, at: 11 },
      ...(detached ? [{ type: "InvocationDetached", direction: "incoming", reference: { target: self, invocation }, at: 12 }] : []),
      ...(terminal ? [
        { type: "ResponseReceived", id: "reply", method: "work", call: "child-job", from: formatThreadAddress(child), status: "completed", output: "ok", at: 12 },
        cancels ? { type: "WorkCancelled", id: "job", cause: "requested", at: 13 } : { type: "WorkCompleted", id: "job", result: "done", at: 13 },
        { type: "ResponseDelivered", method: "work", call: "job", at: 14 }
      ] : [])
    ].map((event, index) => eventAt(event, index + 1))
    const original = actorRuntimeOf(fixture()).projection!
    const observe = (projection: typeof original, state: unknown) => {
      const output = projection.output(state)
      return {
        saved: projection.checkpoint!.encode(state),
        cancellation: output.cancellationOf(invocation), suppressed: output.suppresses(invocation),
        work: [...output.continuations, ...(output.residuals ?? [])].map(work => ({
          key: work.key, kind: work.kind, invocation: work.invocation,
          events: work.kind === "intent" ? work.events(work.input, 123) : []
        }))
      }
    }
    let state = original.initial()
    const expected = [observe(original, state)]
    for (const event of log) { state = original.step(state, event); expected.push(observe(original, state)) }
    for (let cut = 0; cut <= log.length; cut++) {
      const fresh = actorRuntimeOf(fixture({ restoring: true })).projection!
      let restored = fresh.checkpoint!.decode(JSON.parse(JSON.stringify(expected[cut]!.saved)))
      for (let end = cut; end <= log.length; end++) {
        expect(observe(fresh, restored)).toEqual(expected[end]!)
        if (end < log.length) restored = fresh.step(restored, log[end]!)
      }
    }
  }))
})

test.each(["complete", "requested", "deadline"] as const)("restored actor delivers its response after %s", async mode => {
  const cancels = mode !== "complete"
  const worker = mode !== "deadline"
  const events: Event[] = [started(), ...(mode === "requested" ? [cancellation()] : mode === "deadline" ? [{ type: "AlarmFired", scheduledFor: 10, at: 11 }] : [])]
  const sent: unknown[] = []
  let allowRead = true
  const log = Layer.succeed(EventLog, {
    read: Effect.sync(() => { if (!allowRead) throw new Error("startup read the checkpoint prefix"); return [...events] }),
    head: Effect.sync(() => events.length), readFrom: mark => Effect.sync(() => events.slice(mark)),
    append: batch => Effect.sync(() => { events.push(...batch) })
  })
  const services = Layer.mergeAll(log, Layer.succeed(Self, self), Layer.succeed(Router, { send: envelope => Effect.sync(() => { sent.push(envelope) }) }))
  const original = createActorReconciler(fixture({ worker }))
  expect(original.supportsCheckpoints).toBe(true)
  const checkpoint = JSON.parse(JSON.stringify(await Effect.runPromise(original.checkpoint.pipe(Effect.provide(services)))))
  allowRead = false
  const restored = createActorReconciler(fixture({ restoring: true, worker }), { checkpoint })
  await Effect.runPromise(restored.checkpoint.pipe(Effect.provide(services)))
  allowRead = true
  await Effect.runPromise(restored.settle.pipe(Effect.provide(services)))
  expect(events.map(event => event.type)).toEqual(mode === "deadline"
    ? ["WorkStarted", "AlarmFired", "CancellationRequested", "WorkCancelled", "ResponseDelivered"]
    : cancels
    ? ["WorkStarted", "CancellationRequested", "WorkCancelled", "ResponseDelivered"]
    : ["WorkStarted", "WorkCompleted", "ResponseDelivered"])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ event: { type: "ResponseReceived", status: cancels ? "cancelled" : "completed" } })
  expect(events.at(-1)).toMatchObject({ transitionRef: { seq: 1, component: "actor.responses", tag: "deliver" } })
  const completed = await Effect.runPromise(restored.checkpoint.pipe(Effect.provide(services)))
  await Effect.runPromise(createActorReconciler(fixture({ restoring: true, worker }), { checkpoint: JSON.parse(JSON.stringify(completed)) }).settle.pipe(Effect.provide(services)))
  expect(sent).toHaveLength(1)
})

test("control restore rejects method drift, malformed state, and missing codecs", () => {
  const original = actorRuntimeOf(fixture()).projection!
  const saved = original.checkpoint!.encode(replayState(original, [started(), linked(), cancellation()]))
  expect(() => actorRuntimeOf(fixture({ version: "2" })).projection!.checkpoint!.decode(saved)).toThrow("method")
  const cancellationState = saved.children[0]!
  const own = cancellationState.state as { methods: ReadonlyArray<{ name: string; version: string; state: Schema.Json }>; bookkeeping: Schema.Json }
  for (const methods of [[], [{ ...own.methods[0]!, name: "other" }], [{ ...own.methods[0]!, state: 123 }]]) {
    expect(() => original.checkpoint!.decode({ ...saved, children: [{ ...cancellationState, state: { ...own, methods } }] })).toThrow()
  }
  expect(() => original.checkpoint!.decode({ ...saved, state: { response: {}, timeout: {} } })).toThrow()
  expect(createActorReconciler(fixture({ codec: false })).supportsCheckpoints).toBe(false)
  expect(() => fixture({ version: "" })).toThrow("nonempty version")
  const executable = replayState(original, [{ ...started(), input: () => "closure" }])
  expect(() => original.checkpoint!.encode(executable)).toThrow()
})
