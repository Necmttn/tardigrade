import { expect, test } from "bun:test"
import { Schema } from "effect"
import * as fc from "fast-check"
import { component } from "@clavia/tardigrade-core/component"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { replayState } from "@clavia/tardigrade-core/projection"
import { testMachineOf as machineOf } from "../../../fixtures/component"
import { AGENT_VIEW_ALGEBRA } from "../view"
import { toolCommand } from "./command"
import { toolComponent } from "./machine"

const make = (restoring = false, durable = false) => {
  const implementation = toolCommand({ name: "read", version: "1", schema: Schema.Struct({ revision: Schema.Finite }),
    serve: (input, _call, _log, answer) => [answer(input.revision)] })
  const source = component({
    name: "historical",
    checkpoint: { version: "1", schema: Schema.Struct({ revision: Schema.Finite, hidden: Schema.Boolean }) },
    initial: () => { if (restoring) throw new Error("restore ran initial"); return { revision: 0, hidden: false } },
    step: (state, event) => event.type === "Changed" ? { ...state, revision: Number(event.revision) }
      : event.type === "ToolCalled" ? { ...state, hidden: true } : state,
    output: state => {
      const offer = { spec: { name: "read", description: "Read the offered revision", inputSchema: {} },
        ...(durable ? { command: implementation.command({ revision: state.revision }) } : { serve: (_call: import("./machine").PendingCall, _log: readonly Event[], answer: import("./machine").Answer) => [answer(state.revision)] }) }
      return { view: { ...AGENT_VIEW_ALGEBRA.empty, tools: state.hidden ? [] : [{ spec: offer.spec }] }, transitions: [], interactions: { tools: () => state.hidden ? [] : [offer] } }
    }
  })
  const tools = toolComponent(source, { checkpoint: { version: "1" }, implementations: durable ? [implementation] : [] })
  return machineOf(component({
    name: "parent", children: tools,
    checkpoint: { version: "1", schema: Schema.Null },
    initial: () => { if (restoring) throw new Error("restore ran parent initial"); return null },
    step: state => state,
    output: (_state, child) => child.output()
  }))
}
const cancellation = { request: "stop", invocation: { method: "message", id: "turn", epoch: 0 }, cause: "requested" as const }
const describe = (machine: ReturnType<typeof make>, state: unknown) => {
  const output = machine.output(state)
  const work = (transitions: typeof output.transitions) => transitions.map(proposal => ({
    key: proposal.key, invocation: proposal.invocation,
    events: proposal.kind === "intent" ? proposal.events(proposal.input, 123) : []
  }))
  return { checkpoint: machine.checkpoint!.encode(state), view: output.view,
    work: work(output.transitions), cancellation: work(output.interactions?.cancel?.(cancellation) ?? []) }
}

for (const durable of [false, true]) test(`${durable ? "command" : "historical"} tool offers survive every checkpoint cut, state changes, and repeated fresh restores`, () => {
  const machine = (restoring = false) => make(restoring, durable)
  fc.assert(fc.property(fc.boolean(), fc.integer({ min: 0, max: 100 }), fc.array(fc.integer({ min: 101, max: 200 }), { minLength: 1, maxLength: 6 }), (hasModelOffer, revision, changes) => {
    const events = [
      { type: "MessageReceived", id: "turn", text: "read" },
      { type: "Changed", revision },
      ...(hasModelOffer ? [{ type: "ModelCalled", turn: "turn", callId: "model" }] : []),
      ...changes.map(revision => ({ type: "Changed", revision })),
      { type: "ToolCalled", turn: "turn", callId: "call", name: "read", arguments: {} },
      { type: "Changed", revision: 999 }
    ].map((event, index) => eventAt(event, index + 1))
    for (let cut = 0; cut <= events.length; cut++) {
      const original = machine()
      let fresh = machine(true)
      let state = fresh.checkpoint!.decode(JSON.parse(JSON.stringify(original.checkpoint!.encode(replayState(original, events.slice(0, cut))))))
      for (let index = cut; index <= events.length; index++) {
        expect(describe(fresh, state)).toEqual(describe(original, replayState(original, events.slice(0, index))))
        const next = machine(true)
        state = next.checkpoint!.decode(JSON.parse(JSON.stringify(fresh.checkpoint!.encode(state))))
        fresh = next
        if (index < events.length) state = fresh.step(state, events[index]!)
      }
      if (durable) expect(JSON.stringify(fresh.checkpoint!.encode(state))).not.toContain("snapshot")
      const output = fresh.output(state)
      expect(output.view.tools).toEqual([])
      const proposal = output.transitions[0]!
      if (proposal.kind !== "intent") throw new Error("expected tool completion")
      const completed = proposal.events(proposal.input, 123)
      expect(completed[0]).toMatchObject({ type: "ToolReturned", result: hasModelOffer ? revision : changes.at(-1) })
      const settled = fresh.step(state, eventAt(completed[0]!, events.length + 1))
      expect(fresh.output(settled).transitions).toEqual([])
      const replayed = machine()
      expect(describe(fresh, settled)).toEqual(describe(replayed, replayState(replayed, [...events, eventAt(completed[0]!, events.length + 1)])))
      const cleanup = output.interactions!.cancel!(cancellation)[0]!
      if (cleanup.kind !== "intent") throw new Error("expected cancellation intent")
      const cancelled = fresh.step(state, eventAt(cleanup.events(cleanup.input, 123)[0]!, events.length + 1))
      expect(fresh.output(cancelled).transitions).toEqual([])
    }
  }), { includeErrorInReport: true })
}, 30_000)
