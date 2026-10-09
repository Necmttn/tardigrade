import { expect, test } from "bun:test"
import { arrivals, demoWake } from "./activity"
import { demoThreads, type Event } from "./data"
import { initialModel, Message, update } from "./main"

const event = (
  seq: number,
  tag: string,
  extra: Partial<Event> = {}
): Event => ({ seq, tag, at: seq * 100, detail: "", ...extra })
test("arrival order alone never becomes a causal link", () => {
  const rows = arrivals([event(1, "AlarmFired"), event(2, "ModelCalled")])
  expect(rows[0]?.linked).toBe(false)
  expect(rows[0]?.next?.seq).toBe(2)
  expect(rows[0]?.source).toBe("Platform alarm")
})
test("message identifiers link only to the matching turn", () => {
  const rows = arrivals([
    event(1, "MessageReceived", { receiptId: "turn-a" }),
    event(2, "ModelCalled", { turn: "turn-b" }),
    event(3, "ModelCalled", { turn: "turn-a" })
  ])
  expect(rows[0]?.linked).toBe(true)
  expect(rows[0]?.next?.seq).toBe(3)
})
test("an unlinked arrival stops at the next incoming event", () => {
  const rows = arrivals([
    event(1, "ResponseReceived"),
    event(2, "AlarmFired"),
    event(3, "ModelCalled")
  ])
  expect(rows[0]?.next).toBeUndefined()
  expect(rows[1]?.next?.seq).toBe(3)
})
test("demo replay moves through waiting, delivery, execution, and completion", () => {
  let model = update(initialModel, Message.Select({ id: "demo-0" })).model
  model = update(model, Message.ReplayWake()).model
  expect(model.threads[0]?.status).toBe("waiting")
  expect(arrivals(model.events)).toHaveLength(0)
  model = update(model, Message.StepWake()).model
  expect(arrivals(model.events)).toHaveLength(1)
  expect(model.threads[0]?.status).toBe("waiting")
  model = update(model, Message.StepWake()).model
  expect(model.threads[0]?.status).toBe("running")
  model = update(model, Message.StepWake()).model
  expect(model.threads[0]?.status).toBe("settled")
  expect(model.events.at(-1)?.tag).toBe("TurnCompleted")
})
test("demo controls cannot mutate live records", () => {
  const model = { ...initialModel, source: "live" as const, selected: "demo-0" }
  expect(update(model, Message.ReplayWake()).model).toBe(model)
  expect(update(model, Message.StepWake()).model).toBe(model)
})
test("alarm and child response samples preserve distinct arrival types", () => {
  const thread = demoThreads(1)[0]!
  expect(arrivals(demoWake(thread, "alarm", 3))[0]?.event.tag).toBe(
    "AlarmFired"
  )
  expect(arrivals(demoWake(thread, "response", 3))[0]?.event.tag).toBe(
    "ResponseReceived"
  )
})
