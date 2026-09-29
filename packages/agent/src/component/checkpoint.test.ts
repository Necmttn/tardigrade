import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fc from "fast-check"
import { type ComponentMachine } from "@clavia/tardigrade-core/actor"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { replayState } from "@clavia/tardigrade-core/projection"
import { methodInputValidationComponents } from "@clavia/tardigrade-core/actor/validation"
import { initialTurnProjection, reduceTurnProjection, TurnProjectionState, turnViewFrom } from "@clavia/tardigrade-code/execution/turn-projection"
import { definePackage } from "@clavia/tardigrade-code/package/definition"
import { testMachineOf as machineOf } from "../../fixtures/component"
import { agentMessageMethod } from "../actor/message"
import { budgetAuthority } from "./escalate/budget-authority"
import { permissionAuthority } from "./escalate/permission-authority"
import { messages } from "./messages"
import { nativeOutput } from "./native-output"
import { system } from "./system"

const check = <V, R, Result, I>(make: () => ComponentMachine<V, R, Result, I>, events: ReadonlyArray<Event>) => {
  const log = events.map((event, index) => eventAt(event, 100 + index))
  const original = make()
  const observe = (machine: ComponentMachine<V, R, Result, I>, state: unknown) => {
    const output = machine.output(state)
    return {
      state: machine.checkpoint!.encode(state),
      view: output.view,
      work: output.transitions.map(work => ({
        key: work.key,
        invocation: work.invocation,
        events: work.kind === "intent" ? work.events(work.input, 123) : undefined
      }))
    }
  }
  let replayed = original.initial()
  const expected = [observe(original, replayed)]
  for (const event of log) {
    replayed = original.step(replayed, event)
    expected.push(observe(original, replayed))
  }
  for (let cut = 0; cut <= log.length; cut++) {
    const saved = JSON.parse(JSON.stringify(expected[cut]!.state))
    const fresh = make()
    let state = fresh.checkpoint!.decode(saved)
    for (let end = cut; end <= log.length; end++) {
      expect(observe(fresh, state)).toEqual(expected[end]!)
      if (end < log.length) state = fresh.step(state, log[end]!)
    }
  }
}

const leaves: ReadonlyArray<readonly [string, () => ComponentMachine<unknown, unknown, never>]> = [
  ["messages", () => machineOf(messages())],
  ["native output", () => machineOf(nativeOutput)],
  ["static system", () => machineOf(system("instructions"))],
  ["dynamic system", () => machineOf(system(log => String(log.length)))],
  ["budget authority", () => machineOf(budgetAuthority())],
  ["permission authority", () => machineOf(permissionAuthority({ decide: request => request.deny("private") }))],
  ["custom system projection", () => machineOf(system({
    state: { version: "1", schema: Schema.toCodecJson(TurnProjectionState) },
    initial: initialTurnProjection,
    step: reduceTurnProjection,
    output: state => String(turnViewFrom(state).length)
  }))]
]

test.each(leaves)("%s preserves JSON checkpoint plus every tail", (_name, make) => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 20 }), { maxLength: 5 }), amounts => {
    check(make, amounts.flatMap((amount, index): Event[] => [
      { type: "MessageReceived", id: `turn-${index}`, text: "hello" },
      { type: "BudgetRequestReceived", id: `budget-${index}`, request: "tool", turn: `turn-${index}`, amount, reason: "continue" },
      { type: "PermissionRequestReceived", id: `permission-${index}`, request: "tool", action: "write", reason: "save" },
      { type: "TurnCompleted", turn: `turn-${index}`, output: "done" }
    ]))
  }))
})

test("message validation restores a pending rejection with its original identity", () => {
  check(() => machineOf(methodInputValidationComponents({ message: agentMessageMethod })[0]!), [
    { type: "MessageReceived", id: "invalid", text: "hello", model: "historical-model-string" },
    { type: "TurnFailed", turn: "invalid", cause: "message_invalid" },
    { type: "MessageReceived", id: "valid", text: "hello" }
  ])
})

test("manual authority restore keeps decisions callable at commit time", () => {
  const original = machineOf(budgetAuthority.manual())
  const log = [eventAt({ type: "BudgetRequestReceived", id: "request", request: "tool", turn: "turn", amount: 3, reason: "continue" }, 42)]
  const before = replayState(original, log)
  const fresh = machineOf(budgetAuthority.manual())
  const after = fresh.checkpoint!.decode(JSON.parse(JSON.stringify(original.checkpoint!.encode(before))))
  const reply = (machine: typeof original, state: unknown) => {
    const intent = machine.output(state).interactions!.respond("request", { granted: 3 })!
    return { key: intent.key, events: intent.events(intent.input, 456) }
  }
  expect(reply(fresh, after)).toEqual(reply(original, before))
})

test("package calls restore pending work without executing the handler", () => {
  let calls = 0
  const make = () => machineOf(definePackage({
    name: "search",
    description: "search",
    methods: { run: () => Effect.sync(() => { calls++; return "found" }) }
  }))
  check(make, [
    { type: "MessageReceived", id: "turn", text: "search" },
    { type: "PackageCalled", callId: "call", name: "search.run", arguments: {}, turn: "turn" },
    { type: "PackageReturned", callId: "call", result: "found", turn: "turn" }
  ])
  expect(calls).toBe(0)
})

test("event-backed checkpoints reject executable payloads", () => {
  const machine = machineOf(messages())
  const state = replayState(machine, [{ type: "Custom", callback: () => 1 }])
  expect(() => machine.checkpoint!.encode(state)).toThrow()
})
