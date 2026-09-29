import { expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { RecordedEvent, eventAt, eventPositionOf } from "../event"
import { replayState } from "../projection/projection"
import { interactionScope } from "../transition/interaction"
import { component } from "./machine"
import { machineOf } from "./runtime"
import { composeComponents } from "./composition/siblings"

const State = Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Int }))
const worker = (restoring = false) => machineOf(component({
  name: "worker",
  state: { version: "1", schema: State },
  initial: (): typeof State.Type => {
    if (restoring) throw new Error("restore called initial")
    return []
  },
  step: (state, event) => event.type === "Requested"
    ? [...state, { id: String(event.id), position: eventPositionOf(event)! }]
    : event.type === "Completed" ? state.filter(job => job.id !== event.id) : state,
  output: (state, _children, _data, context) => ({
    view: state.map(job => job.id),
    transitions: state.map(job => context.transition(eventAt({ type: "Requested" }, job.position))
      .intent("complete", { type: "Completed", id: job.id }))
  })
}))
const observe = (machine: ReturnType<typeof worker>, state: unknown) => ({
  state: machine.checkpoint!.encode(state),
  view: machine.output(state).view,
  work: machine.output(state).transitions.map(work => ({
    key: work.key, events: work.kind === "intent" ? work.events(work.input, 123) : []
  }))
})

test("checkpoint plus every tail matches full replay in a fresh component", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 12 }), completed => {
    const log = completed.flatMap((done, id) => [
      { type: "Requested", id: String(id) }, ...(done ? [{ type: "Completed", id: String(id) }] : [])
    ]).map((event, index) => eventAt(event, index + 1))
    for (let cut = 0; cut <= log.length; cut++) {
      const original = worker()
      const saved = JSON.parse(JSON.stringify(original.checkpoint!.encode(replayState(original, log.slice(0, cut)))))
      const fresh = worker(true)
      let state = fresh.checkpoint!.decode(saved)
      for (let end = cut; end <= log.length; end++) {
        expect(observe(fresh, state)).toEqual(observe(original, replayState(original, log.slice(0, end))))
        if (end < log.length) state = fresh.step(state, log[end]!)
      }
    }
  }))
})

test("checkpoint decoding rejects incompatible identity, version, and invalid state", () => {
  const machine = worker()
  const saved = machine.checkpoint!.encode(machine.initial())
  for (const invalid of [null, { ...saved, component: "other" }, { ...saved, version: "2" }, { ...saved, state: [{ id: 123 }] }]) {
    expect(() => machine.checkpoint!.decode(invalid)).toThrow()
  }
})

test("checkpoint support requires a versioned schema throughout the subtree", () => {
  const definition = { name: "plain", initial: () => 0, step: (state: number) => state, output: (view: number) => ({ view, transitions: [] }) }
  const plain = component(definition)
  expect(machineOf(plain).checkpoint).toBeUndefined()
  expect(machineOf(composeComponents("unsupported", { empty: 0, combine: (a, b) => a + b }, [plain])).checkpoint).toBeUndefined()
  expect(() => component({ ...definition, state: { version: "", schema: Schema.Finite } })).toThrow("nonempty version")
  expect(machineOf(component({ ...definition, name: "parent", children: plain, state: { version: "1", schema: Schema.Finite } })).checkpoint).toBeUndefined()
})


test("restored output rebuilds invocation identity with fresh interaction scopes", () => {
  const make = (restoring = false) => {
    const receive = interactionScope("receiver").define<number>((value, { id, at }) => ({ type: "Received", id, value, at }))
    const State = Schema.toCodecJson(Schema.NullOr(RecordedEvent))
    return machineOf(component({
      name: "sender", input: { receive }, state: { version: "1", schema: State },
      initial: (): typeof State.Type => { if (restoring) throw new Error("restore called initial"); return null },
      step: (state, event) => event.type === "Requested" ? event : state,
      output: (state, _children, _data, context) => ({
        view: null,
        transitions: state === null ? [] : [context.transition(state).interaction("deliver", receive(7))]
      })
    }))
  }
  const invocation = { method: "message", id: "turn", epoch: 2 }
  const original = make()
  const state = original.step(original.initial(), eventAt({ type: "Requested", invocationRef: invocation }, 42))
  const saved = JSON.parse(JSON.stringify(original.checkpoint!.encode(state)))
  const fresh = make(true)
  const restored = fresh.checkpoint!.decode(saved)
  const before = original.output(state).transitions[0]!
  const after = fresh.output(restored).transitions[0]!
  expect(after.key).toBe(before.key)
  expect(after.invocation).toEqual(invocation)
  if (before.kind !== "intent" || after.kind !== "intent") throw new Error("expected interaction intents")
  expect(after.events(after.input, 123)).toEqual(before.events(before.input, 123))
  expect(after.events(after.input, 123)[0]).toMatchObject({ type: "Received", value: 7, at: 123, invocationRef: invocation })
})

const tree = (restoring = false) => {
  const receive = interactionScope("tree.receiver").define<string>((id, { at }) => ({ type: "Completed", id, at }))
  const initial = <T>(value: T): T => { if (restoring) throw new Error("restore called initial"); return value }
  const leaf = (name: string) => component({
    name, state: { version: "1", schema: Schema.toCodecJson(Schema.Array(RecordedEvent)) },
    initial: () => initial<ReadonlyArray<import("../event").Event>>([]),
    step: (state, event) => event.type === "Requested" && event.owner === name ? [...state, event]
      : event.type === "Completed" ? state.filter(request => request.id !== event.id) : state,
    output: (state, _children, _data, context) => ({
      view: state.map(request => String(request.id)),
      transitions: state.map(request => context.transition(request).interaction("complete", receive(String(request.id)))),
      interactions: { cancel: () => state.map(request => context.transition(request).intent("cancel", { type: "Cancelled", id: request.id })) }
    })
  })
  const siblings = composeComponents("group", { empty: [] as string[], combine: (a: string[], b: string[]) => [...a, ...b] }, [leaf("left"), leaf("right")], {
    reconcile: (log, work) => log[log.length - 1]?.type === "Pause" ? [] : work
  })
  return machineOf(component({
    name: "parent", input: { receive }, children: siblings,
    state: { version: "1", schema: Schema.Int },
    initial: () => initial(0),
    step: (state, _event, _context, child, previous) => state + child.output().view.length - previous.output().view.length,
    output: (state, child) => ({ ...child.output(), view: { count: state, pending: child.output().view } })
  }))
}

test("nested checkpoints rebuild children, reconciliation, scopes, and cancellation across every tail", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 6 }), completed => {
    const log = completed.flatMap((done, id) => [
      { type: "Requested", id: String(id), owner: id % 2 === 0 ? "left" : "right" },
      { type: "Pause" },
      ...(done ? [{ type: "Completed", id: String(id) }] : [])
    ]).map((event, index) => eventAt(event, 50 + index))
    const original = tree()
    const observe = (machine: ReturnType<typeof tree>, state: unknown) => {
      const output = machine.output(state)
      const intents = [...output.transitions, ...(output.interactions?.cancel?.({ request: "cancel", invocation: { method: "message", id: "turn", epoch: 0 }, cause: "requested" }) ?? [])]
      return {
        saved: machine.checkpoint!.encode(state), view: output.view,
        work: intents.map(work => ({ key: work.key, events: work.kind === "intent" ? work.events(work.input, 123) : [] }))
      }
    }
    let replayed = original.initial()
    const expected = [observe(original, replayed)]
    for (const event of log) {
      replayed = original.step(replayed, event)
      expected.push(observe(original, replayed))
    }
    for (let cut = 0; cut <= log.length; cut++) {
      const fresh = tree(true)
      let state = fresh.checkpoint!.decode(JSON.parse(JSON.stringify(expected[cut]!.saved)))
      for (let end = cut; end <= log.length; end++) {
        expect(observe(fresh, state)).toEqual(expected[end]!)
        if (end < log.length) state = fresh.step(state, log[end]!)
      }
    }
  }))
})

test("nested checkpoints reject changed child identity, order, version, shape, or binding", () => {
  const machine = tree()
  const saved = machine.checkpoint!.encode(machine.initial())
  const group = saved.children[0]!
  const first = group.children[0]!
  const withChildren = (children: typeof group.children) => ({ ...saved, children: [{ ...group, children }] })
  for (const invalid of [
    { ...saved, children: [] },
    { ...saved, children: [...saved.children, group] },
    { ...saved, binding: undefined },
    withChildren([...group.children].reverse()),
    withChildren([{ ...first, version: "other" }, group.children[1]!]),
    withChildren([{ ...first, state: 123 }, group.children[1]!])
  ]) expect(() => tree(true).checkpoint!.decode(invalid)).toThrow()
})

test("parent restore preserves admission preview coordinates when later events leave children unchanged", () => {
  const make = () => machineOf(component({
    name: "admission", state: { version: "1", schema: Schema.Int },
    children: component({
      name: "preview", state: { version: "1", schema: Schema.toCodecJson(Schema.NullOr(RecordedEvent)) },
      initial: (): import("../event").Event | null => null,
      step: (state, event) => event.type === "Requested" || event.type === "Previewed" ? event : state,
      output: (event, _children, _data, context) => ({
        view: event === null ? null : { position: eventPositionOf(event), at: event.at },
        transitions: event?.type !== "Requested" ? [] : [context.transition(event).intent("preview", at => ({ type: "Previewed", at }))]
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
