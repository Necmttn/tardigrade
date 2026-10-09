import { expect, test } from "bun:test"
import { initialModel, Message, update } from "./main"

test("source changes invalidate pending server results", () => {
  const live = update(initialModel, Message.Source({ source: "live" })).model
  const demo = update(live, Message.Source({ source: "demo" })).model
  const result = update(
    demo,
    Message.FleetLoaded({
      generation: live.generation,
      threads: [],
      at: "old"
    })
  )
  expect(result.model).toBe(demo)
  expect(demo.threads.length).toBe(256)
})
test("selection changes reject late events for another thread", () => {
  const model = { ...initialModel, source: "live" as const, selected: "new" }
  const result = update(
    model,
    Message.EventsLoaded({
      generation: model.generation,
      id: "old",
      events: [{ seq: 1, at: 0, tag: "wrong", detail: "" }]
    })
  )
  expect(result.model).toBe(model)
})
test("actor changes clear old records and invalidate pending requests", () => {
  const result = update(
    { ...initialModel, source: "live" },
    Message.Setting({ key: "actor", value: "other" })
  ).model
  expect(result.threads).toEqual([])
  expect(result.selected).toBe("")
  expect(result.generation).toBe(initialModel.generation + 1)
})
test("polling does not overlap fleet requests", () => {
  const live = update(initialModel, Message.Source({ source: "live" })).model
  expect(update(live, Message.Refresh()).commands).toBeUndefined()
})
test("failed refresh preserves records with a visible error", () => {
  const live = { ...initialModel, source: "live" as const, loading: true }
  const next = update(
    live,
    Message.FleetFailed({ generation: live.generation })
  ).model
  expect(next.threads).toEqual(live.threads)
  expect(next.error).toContain("Cannot read")
  expect(next.loading).toBe(false)
})
test("keyboard pan moves the camera without starting a drag", () => {
  const next = update(initialModel, Message.Pan({ x: 80, y: -80 })).model
  expect(next.camera.x).toBe(initialModel.camera.x + 80)
  expect(next.drag).toBeNull()
})
test("settings reject invalid request limits", () => {
  for (const value of ["0", "-1", "NaN", "Infinity", "1.5"])
    expect(
      update(initialModel, Message.Setting({ key: "eventLimit", value })).model
    ).toBe(initialModel)
})
