import { expect, test } from "bun:test"
import { eventAt } from "../event"
import { bindTransitionContext, eventIntent, eventIntentRecordOf, restoreEventIntent, validateTransitions, withResponse } from "./transition"
import { pureData } from "./data"

test("event records preserve response identity and use the actual commit timestamp after restore", () => {
  const invocation = { method: "message", id: "turn", epoch: 2 }
  const context = bindTransitionContext(eventAt({ type: "ToolCalled", invocationRef: invocation }, 17), "tools")
  const payload = { type: "ToolReturned", callId: "call", result: { revision: 7 } }
  const original = eventIntent(context, "answer", [payload])
  payload.result.revision = 99
  const record = eventIntentRecordOf(original)!
  const restored = restoreEventIntent(JSON.parse(JSON.stringify(record)))
  expect(restored.key).toBe(original.key)
  expect(restored.invocation).toEqual(invocation)
  expect(validateTransitions([restored], "tools")).toEqual([restored])
  for (const at of [0, 123, 999_999]) {
    expect(restored.events(restored.input, at)).toEqual(original.events(original.input, at))
    expect(restored.events(restored.input, at)[0]).toMatchObject({ at, result: { revision: 7 } })
  }
  const proposal = withResponse(context.intent("dispatch", { type: "Dispatch" }), result => eventIntent(context, "answer", [{ type: "ToolReturned", result }]))
  expect(eventIntentRecordOf(proposal.respond("refused"))).toBeDefined()
})

test("event records reject runtime objects and cannot reinterpret arbitrary callbacks", () => {
  const context = bindTransitionContext(eventAt({ type: "Call" }, 1), "tools")
  let evaluated = false
  const callback = context.intent("answer", at => { evaluated = true; return { type: "Result", value: at * 2 } })
  expect(eventIntentRecordOf(callback)).toBeUndefined()
  expect(evaluated).toBe(false)
  for (const value of [() => 1, new Map(), new Date(), undefined, NaN, Infinity, -0]) {
    expect(() => eventIntent(context, "answer", [{ type: "Result", value }])).toThrow()
  }
  for (const metadata of [{ at: 123 }, { transitionRef: {} }, { invocationRef: {} }]) {
    expect(() => eventIntent(context, "answer", [{ type: "Result", ...metadata }])).toThrow()
  }
  let getters = 0
  expect(() => pureData({ get value() { getters++; return 1 } })).toThrow()
  expect(getters).toBe(0)
  const response = eventIntent(context, "answer", [{ type: "Result" }], { invocation: null })
  const record = eventIntentRecordOf(response)!
  expect(() => restoreEventIntent({ ...record, version: "2" } as unknown as typeof record)).toThrow()
  expect(restoreEventIntent(record).invocation).toBeUndefined()
})
