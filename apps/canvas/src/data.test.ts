import { describe, expect, test } from "bun:test"
import {
  demoThreads,
  fit,
  layout,
  matches,
  parseEvents,
  parseThreads,
  zoomAt
} from "./data"

describe("graph", () => {
  test("places 1024 nodes without overlap and preserves parent identifiers", () => {
    const threads = demoThreads(1024)
    const graph = layout(threads)
    expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(1024)
    for (const node of graph.nodes) {
      expect(Number.isFinite(node.x + node.y)).toBe(true)
      if (node.parent)
        expect(threads.some((t) => t.id === node.parent)).toBe(true)
      expect(
        graph.nodes.some(
          (other) =>
            node.id !== other.id &&
            Math.abs(node.x - other.x) < 198 &&
            Math.abs(node.y - other.y) < 48
        )
      ).toBe(false)
    }
  })
  test("handles orphans, cycles, and self references without losing records", () => {
    const base = demoThreads(4)
    const threads = base.map((t, i) => ({
      ...t,
      parent: ["missing", "demo-2", "demo-1", "demo-3"][i]!
    }))
    const graph = layout(threads)
    expect(new Set(graph.nodes.map((t) => t.id)).size).toBe(4)
    expect(graph.nodes.every((n) => Number.isFinite(n.x + n.y))).toBe(true)
  })
  test("keeps separate roots clear of a deep component", () => {
    const threads = demoThreads(60).map((t, i) => ({
      ...t,
      parent: i === 0 || i === 59 ? "" : `demo-${i - 1}`
    }))
    const graph = layout(threads)
    const separate = graph.nodes.find((n) => n.id === "demo-59")!
    expect(separate.x).toBeGreaterThan(
      Math.max(
        ...graph.nodes.filter((n) => n.id !== separate.id).map((n) => n.x + 198)
      )
    )
  })
  test("zooms around the pointer and fits a normal fleet", () => {
    const camera = { x: 20, y: 30, zoom: 0.6 }
    const point = { x: 300, y: 200 }
    const next = zoomAt(camera, 1.3, point)
    expect((point.x - next.x) / next.zoom).toBeCloseTo(
      (point.x - camera.x) / camera.zoom
    )
    expect((point.y - next.y) / next.zoom).toBeCloseTo(
      (point.y - camera.y) / camera.zoom
    )
    const graph = layout(demoThreads(256))
    const fitted = fit(graph, 900, 700)
    expect(fitted.zoom * graph.width).toBeLessThan(900)
    expect(fitted.zoom * graph.height).toBeLessThan(700)
  })
  test("combines search and state filters", () => {
    const failed = demoThreads(16)[7]!
    expect(matches(failed, "COLLECTOR", "failed")).toBe(true)
    expect(matches(failed, "collector", "running")).toBe(false)
    expect(matches(failed, "missing", "all")).toBe(false)
  })
})
describe("server boundary", () => {
  test("maps known states and leaves unsupported states explicit", () => {
    expect(
      parseThreads([
        { id: "a", status: "blocked", events: 8 },
        { id: "b", parent: "a", status: "new-state" }
      ]).map((t) => t.status)
    ).toEqual(["waiting", "unknown"])
    expect(() => parseThreads([{ id: "a" }, { id: "a" }])).toThrow("duplicate")
    expect(() => parseThreads({})).toThrow()
  })
  test("keeps credentials and request payloads out of inspector state", () => {
    const event = parseEvents([
      {
        seq: 7,
        event: {
          type: "ModelCalled",
          at: 123,
          model: "test-model",
          request: { headers: { authorization: "secret" } },
          text: "private prompt"
        }
      }
    ])[0]
    expect(event).toEqual({
      seq: 7,
      tag: "ModelCalled",
      at: 123,
      detail: "test-model"
    })
    expect(JSON.stringify(event)).not.toContain("secret")
    expect(() => parseEvents([{ event: null }])).toThrow()
  })
})

test("conversation reads user content and final output without model internals", () => {
  const events = parseEvents([
    { seq: 1, event: { type: "MessageReceived", text: "Legacy message" } },
    {
      seq: 2,
      event: {
        type: "MessageReceived",
        content: [
          { type: "text", text: "Hello" },
          { type: "file", url: "secret-url" }
        ]
      }
    },
    {
      seq: 3,
      event: {
        type: "TurnCompleted",
        output: "Answer",
        request: { headers: { authorization: "secret-token" } }
      }
    },
    {
      seq: 4,
      event: {
        type: "ModelReturned",
        reasoning: "private",
        continuation: { text: "private" }
      }
    }
  ])
  expect(events.map((event) => event.message)).toEqual([
    { role: "user", text: "Legacy message" },
    { role: "user", text: "Hello\n[Attachment]" },
    { role: "assistant", text: "Answer" },
    undefined
  ])
  expect(JSON.stringify(events)).not.toContain("secret")
  expect(JSON.stringify(events)).not.toContain("private")
})
