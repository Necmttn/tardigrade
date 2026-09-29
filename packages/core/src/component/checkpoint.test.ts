import fc from "fast-check"
import { composeComponents } from "./composition/siblings"
import { interactionScope } from "../transition/interaction"
import { replayState } from "../projection/projection"
import { actorFromProjections, createActorReconciler } from "../runtime/reconciler"
import { EventLog } from "../log"
import { bindTransitionContext } from "../transition/transition"
import type { Event } from "../event"
import { expect, test } from "bun:test"
import { Schema, Effect, Layer } from "effect"
import { component } from "./machine"
import { machineOf, transitionProjectionOf } from "./runtime"
import { eventAt, eventPositionOf, RecordedEvent } from "../event"

test("leaf checkpoints restore validated state without initialization", () => {
  const make = (restoring = false) => component({
    name: "counter", state: { version: "1", schema: Schema.Int },
    initial: () => { if (restoring) throw new Error("initializer ran"); return 0 },
    step: (state, event) => event.type === "Increment" ? state + 1 : state,
    output: state => ({ view: state, transitions: [] })
  })
  const original = machineOf(make())
  const state = original.step(original.initial(), eventAt({ type: "Increment" }, 1))
  const saved = JSON.parse(JSON.stringify(original.checkpoint!.encode(state)))
  const fresh = machineOf(make(true))
  const restored = fresh.checkpoint!.decode(saved)
  expect(fresh.output(restored).view).toBe(1)
  expect(fresh.output(fresh.step(restored, eventAt({ type: "Increment" }, 2))).view).toBe(2)
  for (const invalid of [null, { ...saved, component: "other" }, { ...saved, version: "2" }, { ...saved, state: "bad" }]) {
    expect(() => fresh.checkpoint!.decode(invalid)).toThrow()
  }
  const parent = component({
    name: "parent", children: make(), state: { version: "1", schema: Schema.Int },
    initial: () => 0, step: state => state, output: state => ({ view: state, transitions: [] })
  })
  expect(machineOf(parent).checkpoint).toBeDefined()
  expect(() => component({
    name: "bad", state: { version: "", schema: Schema.Int },
    initial: () => 0, step: state => state, output: state => ({ view: state, transitions: [] })
  })).toThrow("nonempty version")
})


test("startup checkpoints preserve completed keys even when output still proposes work", async () => {
  const events: Event[] = [{ type: "Requested" }]
  const source = component({
    name: "sticky", state: { version: "1", schema: Schema.Int },
    initial: () => 0, step: state => state,
    output: state => ({ view: state, transitions: [bindTransitionContext(eventAt({ type: "Requested" }, 1), "sticky").intent("answer", { type: "Completed" })] })
  })
  const make = () => actorFromProjections({ transitions: [transitionProjectionOf(source)], keyOf: () => undefined })
  const layer = Layer.succeed(EventLog, {
    read: Effect.sync(() => [...events]), head: Effect.sync(() => events.length),
    readFrom: mark => Effect.sync(() => events.slice(mark)),
    append: batch => Effect.sync(() => { events.push(...batch) })
  })
  const original = createActorReconciler(make())
  await Effect.runPromise(original.settle.pipe(Effect.provide(layer)))
  const checkpoint = JSON.parse(JSON.stringify(await Effect.runPromise(original.checkpoint.pipe(Effect.provide(layer)))))
  expect(checkpoint.recorded).toEqual([JSON.stringify([1, "sticky", "answer"])])
  await Effect.runPromise(createActorReconciler(make(), { checkpoint }).settle.pipe(Effect.provide(layer)))
  expect(events.map(event => event.type)).toEqual(["Requested", "Completed"])
  const unsupported = actorFromProjections({
    transitions: [transitionProjectionOf(source)], keyOf: () => undefined,
    legacy: { cancellationOf: () => undefined }
  })
  await expect(Effect.runPromise(createActorReconciler(unsupported, { checkpoint }).settle.pipe(Effect.provide(layer)))).rejects.toThrow("legacy cancellation")
})


const checkpointTree = (restoring = false, reconcile = true) => {
  const receive = interactionScope("tree.receive").define<string>((id, { at }) => ({ type: "Completed", id, at }))
  const initial = <T>(value: T): T => { if (restoring) throw new Error("restore initialized a component"); return value }
  const leaf = (name: string) => component({
    name, state: { version: "1", schema: Schema.toCodecJson(Schema.Array(RecordedEvent)) },
    initial: () => initial<ReadonlyArray<Event>>([]),
    step: (state, event, context) => {
      if (event.type === "Requested" && event.owner === name) {
        context.interaction("scope-check", receive(String(event.id)))
        return [...state, event]
      }
      return event.type === "Completed" ? state.filter(request => request.id !== event.id) : state
    },
    output: state => ({
      view: state.map(request => String(request.id)),
      transitions: state.map(request => bindTransitionContext(request, name).intent("reply", { type: "Completed", id: request.id })),
      interactions: { cancel: () => state.map(request => bindTransitionContext(request, name).intent("cancel", { type: "Cancelled", id: request.id })) }
    })
  })
  const group = composeComponents("group", { empty: [] as string[], combine: (a: string[], b: string[]) => [...a, ...b] }, [leaf("left"), leaf("right")], reconcile ? { reconcile: (events: ReadonlyArray<Event>, work: ReadonlyArray<import("../transition").Transition<never>>) => events.at(-1)?.type === "Pause" ? [] : work } : {})
  return component({
    name: "parent", input: { receive }, children: group, state: { version: "1", schema: Schema.Int },
    initial: () => initial(0),
    step: (state, _event, _context, child, previous) => state + child.output().view.length - previous.output().view.length,
    output: (state, child) => ({ ...child.output(), view: { count: state, pending: child.output().view } })
  })
}

test("nested parent and sibling restore matches every replay tail including scopes and cancellation", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 8 }), done => {
    const log = done.flatMap((completed, id) => [
      { type: "Requested", owner: id % 2 === 0 ? "left" : "right", id: String(id), at: id + 10 },
      { type: "Pause", at: id + 11 },
      ...(completed ? [{ type: "Completed", id: String(id), at: id + 12 }] : [])
    ]).map((event, index) => eventAt(event, index + 1))
    const originalMachine = () => machineOf(checkpointTree())
    const observe = (machine: ReturnType<typeof originalMachine>, state: unknown) => {
      const output = machine.output(state)
      const work = [...output.transitions, ...(output.interactions?.cancel?.({ request: "cancel", invocation: { method: "message", id: "turn", epoch: 0 }, cause: "requested" }) ?? [])]
      return { saved: machine.checkpoint!.encode(state), view: output.view, work: work.map(item => ({ key: item.key, events: item.kind === "intent" ? item.events(item.input, 123) : [] })) }
    }
    const original = machineOf(checkpointTree())
    let replayed = original.initial()
    const expected = [observe(original, replayed)]
    for (const event of log) { replayed = original.step(replayed, event); expected.push(observe(original, replayed)) }
    for (let cut = 0; cut <= log.length; cut++) {
      const fresh = machineOf(checkpointTree(true))
      let restored = fresh.checkpoint!.decode(JSON.parse(JSON.stringify(expected[cut]!.saved)))
      for (let end = cut; end <= log.length; end++) {
        expect(observe(fresh, restored)).toEqual(expected[end]!)
        if (end < log.length) restored = fresh.step(restored, log[end]!)
      }
    }
  }))
})

test("recursive checkpoints reject incompatible children and require complete codec coverage", () => {
  const machine = machineOf(checkpointTree())
  const saved = machine.checkpoint!.encode(machine.initial())
  const group = saved.children[0]!
  const leaf = group.children[0]!
  for (const invalid of [
    { ...saved, children: [] }, { ...saved, binding: undefined },
    { ...saved, children: [{ ...group, children: [...group.children].reverse() }] },
    { ...saved, children: [{ ...group, children: [{ ...leaf, version: "2" }, group.children[1]!] }] },
    { ...saved, children: [{ ...group, children: [{ ...leaf, state: 123 }, group.children[1]!] }] }
  ]) expect(() => machine.checkpoint!.decode(invalid)).toThrow()
  const plain = component({ name: "plain", initial: () => 0, step: state => state, output: view => ({ view, transitions: [] }) })
  const parent = component({ name: "incomplete", state: { version: "1", schema: Schema.Int }, children: plain, initial: () => 0, step: state => state, output: view => ({ view, transitions: [] }) })
  expect(machineOf(parent).checkpoint).toBeUndefined()
  expect(machineOf(composeComponents("incomplete.group", { empty: 0, combine: (a: number, b: number) => a + b }, [plain])).checkpoint).toBeUndefined()
  const independent = machineOf(checkpointTree(false, false))
  const state = replayState(independent, [eventAt({ type: "Unrelated" }, 1)])
  expect(independent.checkpoint!.encode(state).children[0]!.state).toEqual([])
})

test("parent restore preserves admission preview coordinates when later events leave children unchanged", () => {
  const make = () => machineOf(component({
    name: "admission", state: { version: "1", schema: Schema.Int },
    children: component({
      name: "preview", state: { version: "1", schema: Schema.toCodecJson(Schema.NullOr(RecordedEvent)) },
      initial: (): import("../event").Event | null => null,
      step: (state, event) => event.type === "Requested" || event.type === "Previewed" ? event : state,
      output: event => ({
        view: event === null ? null : { position: eventPositionOf(event), at: event.at },
        transitions: event?.type !== "Requested" ? [] : [bindTransitionContext(event, "preview").intent("preview", at => ({ type: "Previewed", at }))]
      })
    }),
    initial: () => 0, step: state => state + 1,
    output: (_state, child) => {
      const proposal = child.output().transitions[0]
      return { view: proposal === undefined || proposal.kind !== "intent" ? null : child.admission().preview(proposal).output().view, transitions: [] }
    }
  }))
  const original = make()
  const state = replayState(original, [eventAt({ type: "Requested", at: 20 }, 42), eventAt({ type: "Unrelated", at: 90 }, 100)])
  expect(original.output(state).view).toEqual({ position: 43, at: 20 })
  const fresh = make()
  const restored = fresh.checkpoint!.decode(JSON.parse(JSON.stringify(original.checkpoint!.encode(state))))
  expect(fresh.output(restored).view).toEqual(original.output(state).view)
})
