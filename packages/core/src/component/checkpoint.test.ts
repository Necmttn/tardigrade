import { expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { RecordedEvent, eventAt, eventPositionOf } from "../event"
import { replayState } from "../projection/projection"
import { interactionScope } from "../transition/interaction"
import { component } from "./machine"
import { machineOf } from "./runtime"

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

test("checkpoint support is opt-in, versioned, and limited to leaf components", () => {
  const definition = { name: "plain", initial: () => 0, step: (state: number) => state, output: (view: number) => ({ view, transitions: [] }) }
  const plain = component(definition)
  expect(machineOf(plain).checkpoint).toBeUndefined()
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
