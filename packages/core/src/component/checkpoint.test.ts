import * as fc from "fast-check"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { eventAt, eventPositionOf, type Event } from "../event"
import { bindTransitionContext } from "../transition/transition"
import { replayState } from "../projection/projection"
import { component, type ComponentCheckpoint } from "./machine"
import { machineOf } from "./runtime"
import { composeComponents } from "./composition/siblings"

const encode = (machine: ReturnType<typeof machineOf>, state: unknown): ComponentCheckpoint => JSON.parse(JSON.stringify(machine.checkpoint!.encode(state)))
const observe = (machine: ReturnType<typeof machineOf>, state: unknown) => {
  const output = machine.output(state)
  return {
    state: encode(machine, state),
    view: output.view,
    work: output.transitions.map(work => ({
      kind: work.kind,
      key: work.key,
      invocation: work.invocation,
      events: work.kind === "intent" ? work.events(work.input, 123) : []
    }))
  }
}

describe("leaf codecs", () => {
  test("checkpoints reject incompatible identities, versions, and malformed state", () => {
    const machine = machineOf(component({
      name: "counter", checkpoint: { version: "1", schema: Schema.Finite },
      initial: () => 0, step: state => state + 1, output: view => ({ view, transitions: [] })
    }))
    const checkpoint = machine.checkpoint!.encode(machine.initial())
    expect(() => machine.checkpoint!.decode({ ...checkpoint, component: "other" })).toThrow("Incompatible checkpoint")
    expect(() => machine.checkpoint!.decode({ ...checkpoint, version: "2" })).toThrow("Incompatible checkpoint")
    expect(() => machine.checkpoint!.decode({ ...checkpoint, state: { count: "invalid" } })).toThrow()
  })

  test("checkpointing is opt-in and rejects unsupported children and empty versions", () => {
    const definition = { name: "plain", initial: () => 0, step: (state: number) => state, output: (state: number) => ({ view: state, transitions: [] }) }
    expect(machineOf(component(definition)).checkpoint).toBeUndefined()
    expect(() => component({ ...definition, checkpoint: { version: "", schema: Schema.Finite } })).toThrow("nonempty version")
    expect(() => component({ ...definition, children: [component({ ...definition, name: "child" })], checkpoint: { version: "1", schema: Schema.Finite } })).toThrow("every child")
  })

  test("state codecs restore runtime types from JSON data", () => {
    const make = () => machineOf(component({
      name: "date",
      checkpoint: { version: "1", schema: Schema.DateFromString },
      initial: () => new Date("2026-01-01T00:00:00.000Z"),
      step: state => new Date(state.getTime() + 1000),
      output: state => ({ view: state.toISOString(), transitions: [] })
    }))
    const original = make()
    const encoded = JSON.parse(JSON.stringify(original.checkpoint!.encode(original.initial())))
    expect(encoded.state).toBe("2026-01-01T00:00:00.000Z")
    const fresh = make()
    const restored = fresh.checkpoint!.decode(encoded)
    expect(fresh.output(fresh.step(restored, eventAt({ type: "Tick" }, 1))).view).toBe("2026-01-01T00:00:01.000Z")
  })
})

describe("pending work", () => {
  const Job = Schema.Struct({ id: Schema.Finite, value: Schema.Finite, position: Schema.Finite })
  const State = Schema.Struct({ pending: Schema.Array(Job), completed: Schema.Finite, cancelled: Schema.Finite })
  type State = typeof State.Type

  const jobs = (restoring = false) => machineOf(component({
    name: "jobs",
    checkpoint: { version: "1", schema: State },
    initial: (): State => {
      if (restoring) throw new Error("restore must not call initial")
      return { pending: [], completed: 0, cancelled: 0 }
    },
    step: (state, event): State => {
      const existing = state.pending.find(job => job.id === event.id)
      if (event.type === "Requested" && existing === undefined) {
        return { ...state, pending: [...state.pending, { id: Number(event.id), value: Number(event.value), position: eventPositionOf(event)! }] }
      }
      if (existing === undefined) return state
      if (event.type === "Completed") return { ...state, pending: state.pending.filter(job => job !== existing), completed: state.completed + existing.value }
      if (event.type === "Cancelled") return { ...state, pending: state.pending.filter(job => job !== existing), cancelled: state.cancelled + 1 }
      return state
    },
    output: state => ({
      view: { pending: state.pending.length, completed: state.completed, cancelled: state.cancelled },
      transitions: state.pending.map(job => bindTransitionContext(eventAt({ type: "Requested" }, job.position), "jobs")
        .intent("complete", at => ({ type: "Completed", id: job.id, value: job.value, at })))
    })
  }))

  const histories = fc.array(fc.record({
    type: fc.constantFrom("Requested", "Completed", "Cancelled", "Noise"),
    id: fc.integer({ min: 0, max: 3 }),
    value: fc.integer({ min: -100, max: 100 })
  }), { maxLength: 30 }).map(events => events.map((event, index) => eventAt(event, index + 1)))

  // assertSuffix compares each restored prefix with reconstruction from the complete positioned history.
  const assertSuffix = (events: readonly Event[], cut: number) => {
    const before = jobs()
    const checkpoint = encode(before, replayState(before, events.slice(0, cut)))
    let current = jobs(true)
    let state = current.checkpoint!.decode(checkpoint)
    for (let index = cut; index <= events.length; index++) {
      const reference = jobs()
      expect(observe(current, state)).toEqual(observe(reference, replayState(reference, events.slice(0, index))))
      const next = jobs(true)
      state = next.checkpoint!.decode(encode(current, state))
      current = next
      expect(observe(current, state)).toEqual(observe(reference, replayState(reference, events.slice(0, index))))
      if (index < events.length) state = current.step(state, events[index]!)
    }
  }

  test("every checkpoint cut and repeated restart agree with full replay through job lifecycles", () => {
    fc.assert(fc.property(histories, events => {
      for (let cut = 0; cut <= events.length; cut++) assertSuffix(events, cut)
    }))
  })

  test("restored pending work emits completions that settle exactly as uninterrupted work", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 12 }), values => {
      const events = values.map((value, id) => eventAt({ type: "Requested", id, value }, id + 1))
      const original = jobs()
      let originalState = replayState(original, events)
      const restored = jobs(true)
      let restoredState = restored.checkpoint!.decode(encode(original, originalState))
      for (let index = 0; index < values.length; index++) {
        const left = original.output(originalState).transitions[0]!
        const right = restored.output(restoredState).transitions[0]!
        if (left.kind !== "intent" || right.kind !== "intent") throw new Error("expected completion intents")
        const expected = left.events(left.input, index)
        const actual = right.events(right.input, index)
        expect(actual).toEqual(expected)
        originalState = original.step(originalState, eventAt(expected[0]!, events.length + index + 1))
        restoredState = restored.step(restoredState, eventAt(actual[0]!, events.length + index + 1))
        expect(observe(restored, restoredState)).toEqual(observe(original, originalState))
      }
      expect(restored.output(restoredState).view).toEqual({ pending: 0, completed: values.reduce((sum, value) => sum + value, 0), cancelled: 0 })
    }))
  })
})

describe("composition", () => {
  const Frame = Schema.Struct({ count: Schema.Finite, position: Schema.Finite, at: Schema.Finite })
  const leaf = (name: string, restoring = false, version = "1") => component({
    name,
    checkpoint: { version, schema: Frame },
    initial: () => {
      if (restoring) throw new Error("initializer called during restore")
      return { count: 0, position: 0, at: 0 }
    },
    step: (state, event) => event.type === name || event.type === "Preview"
      ? { count: state.count + 1, position: eventPositionOf(event)!, at: Number(event.at ?? 0) } : state,
    output: state => ({
      view: state,
      transitions: state.position === 0 ? [] : [bindTransitionContext(eventAt({ type: name }, state.position), name).intent("advance", at => ({ type: "Preview", at }))]
    })
  })

  const tree = (restoring = false) => {
    const inner = component({
      name: "inner", children: leaf("left", restoring),
      checkpoint: { version: "1", schema: Schema.Finite },
      initial: () => { if (restoring) throw new Error("initializer called during restore"); return 0 },
      step: (state, _event, _context, current, previous) => state + current.output().view.count - previous.output().view.count,
      output: (state, child) => {
        const output = child.output()
        const proposal = output.transitions[0]
        const preview = proposal?.kind === "intent" ? child.admission().preview(proposal).output().view : output.view
        return { view: { state, child: output.view, preview }, transitions: output.transitions }
      }
    })
    return machineOf(component({
      name: "outer", children: [inner, leaf("right", restoring)] as const,
      checkpoint: { version: "1", schema: Schema.Finite },
      initial: () => { if (restoring) throw new Error("initializer called during restore"); return 0 },
      step: state => state + 1,
      output: (state, children) => ({ view: { state, left: children[0].output().view, right: children[1].output().view }, transitions: children.flatMap(child => child.output().transitions) })
    }))
  }

  const algebra = {
    empty: { count: 0, position: 0, at: 0 },
    combine: (left: typeof Frame.Type, right: typeof Frame.Type) => ({ count: left.count + right.count, position: left.position + right.position, at: left.at + right.at })
  }
  const product = (restoring = false, version = "1") => machineOf(composeComponents("product", algebra, [
    composeComponents("nested", algebra, [leaf("left", restoring, version)], { checkpoint: { version: "1" } }),
    leaf("right", restoring)
  ], {
    checkpoint: { version: "1" },
    reconcile: (events, work) => events.filter(event => event.type === "Noise" && (eventPositionOf(event) ?? 0) % 2 === 0).length % 2 === 0 ? work : []
  }))

  for (const [name, make] of [["nested parents and admission previews", tree], ["siblings with history-dependent reconciliation", product]] as const) {
    test(`checkpoint restores ${name} at every cut`, () => {
      fc.assert(fc.property(fc.array(fc.record({ type: fc.constantFrom("left", "right", "Noise"), at: fc.integer({ min: 1, max: 1000 }) }), { maxLength: 16 }), raw => {
        const events = raw.map((event, index) => eventAt(event, index + 1))
        for (let cut = 0; cut <= events.length; cut++) {
          const original = make()
          const prefix = replayState(original, events.slice(0, cut))
          let fresh = make(true)
          let state = fresh.checkpoint!.decode(encode(original, prefix))
          for (let index = cut; index <= events.length; index++) {
            expect(observe(fresh, state)).toEqual(observe(original, replayState(original, events.slice(0, index))))
            const next = make(true)
            state = next.checkpoint!.decode(encode(fresh, state))
            fresh = next
            if (index < events.length) state = fresh.step(state, events[index]!)
          }
        }
      }))
    })
  }

  test("tree restore rejects missing, extra, reordered, and incompatible children", () => {
    for (const machine of [tree(), product()]) {
      const encoded = machine.checkpoint!.encode(machine.initial())
      expect(() => machine.checkpoint!.decode({ ...encoded, children: [] })).toThrow("Incompatible checkpoint children")
      expect(() => machine.checkpoint!.decode({ ...encoded, children: [...encoded.children!, encoded.children![0]!] })).toThrow("Incompatible checkpoint children")
      expect(() => machine.checkpoint!.decode({ ...encoded, children: [...encoded.children!].reverse() })).toThrow("Incompatible checkpoint children")
      expect(() => machine.checkpoint!.decode({ ...encoded, children: encoded.children!.map(child => ({ ...child, version: "other" })) })).toThrow("Incompatible checkpoint")
    }
    const machine = product()
    expect(() => product(false, "2").checkpoint!.decode(machine.checkpoint!.encode(machine.initial()))).toThrow("Incompatible checkpoint")
  })


  test("compositions require opt-in support from every child", () => {
    const unsupported = component({ name: "unsupported", initial: () => ({ count: 0, position: 0, at: 0 }), step: state => state, output: view => ({ view, transitions: [] }) })
    expect(machineOf(composeComponents("plain", algebra, [unsupported])).checkpoint).toBeUndefined()
    expect(() => composeComponents("parent", algebra, [unsupported], { checkpoint: { version: "1" } })).toThrow("every child")
    expect(() => composeComponents("parent", algebra, [], { checkpoint: { version: "" } })).toThrow("nonempty version")
    const empty = machineOf(composeComponents("empty", algebra, [], { checkpoint: { version: "1" } }))
    const history = machineOf(composeComponents("history", algebra, [], { checkpoint: { version: "1" }, reconcile: () => [] }))
    const events = [{ type: "Noise" }, eventAt({ type: "Noise" }, 3)]
    const restored = history.checkpoint!.decode(encode(history, events.reduce((state, event) => history.step(state, event), history.initial())))
    expect(history.checkpoint!.encode(restored).state).toEqual([{ event: { type: "Noise" } }, { event: { type: "Noise" }, position: 3 }])
    const state = empty.initial()
    expect(observe(empty, empty.checkpoint!.decode(encode(empty, state)))).toEqual(observe(empty, state))
  })
})
