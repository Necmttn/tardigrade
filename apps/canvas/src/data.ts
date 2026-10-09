import { Schema } from "effect"

export const DEFAULTS = {
  demoThreads: 256,
  pollMs: 5000,
  eventLimit: 100,
  requestMs: 15000,
  actor: "main"
} as const
export const Status = Schema.Literals([
  "running",
  "waiting",
  "settled",
  "failed",
  "unknown"
])
export type Status = typeof Status.Type
export const Thread = Schema.Struct({
  id: Schema.String,
  parent: Schema.String,
  name: Schema.String,
  group: Schema.String,
  status: Status,
  events: Schema.Finite,
  lastAt: Schema.Finite
})
export type Thread = typeof Thread.Type
export const Event = Schema.Struct({
  seq: Schema.Finite,
  tag: Schema.String,
  at: Schema.Finite,
  detail: Schema.String,
  message: Schema.optionalKey(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String
    })
  )
})
export type Event = typeof Event.Type
const groups = [
  "Market research",
  "Invoice reconciliation",
  "Release review",
  "Customer signals",
  "Documentation",
  "Incident analysis",
  "Content pipeline",
  "Data quality"
]
const roles = [
  "Coordinator",
  "Researcher",
  "Source checker",
  "Analyst",
  "Reviewer",
  "Writer",
  "Verifier",
  "Collector"
]

export function demoThreads(count: number): Thread[] {
  return Array.from({ length: count }, (_, i) => {
    const group = Math.floor(i / 16)
    const local = i % 16
    return {
      id: `demo-${i}`,
      parent:
        local === 0 ? "" : `demo-${group * 16 + Math.floor((local - 1) / 3)}`,
      name: roles[local % roles.length]!,
      group: `${groups[group % groups.length]} ${Math.floor(group / groups.length) + 1}`,
      status:
        i % 37 === 7
          ? "failed"
          : i % 11 === 3
            ? "waiting"
            : i % 5 === 0
              ? "running"
              : "settled",
      events: 12 + ((i * 17) % 140),
      lastAt: 0
    }
  })
}

export function demoEvents(thread: Thread): Event[] {
  const tags = [
    "ThreadCreated",
    "MessageReceived",
    "ModelCalled",
    "ModelReturned",
    "ToolCalled",
    "ToolReturned",
    "ChildCreated",
    "ModelCalled",
    thread.status === "failed"
      ? "TurnFailed"
      : thread.status === "waiting"
        ? "BlockedOn"
        : thread.status === "running"
          ? "ModelCalled"
          : "TurnCompleted"
  ]
  return tags.map((tag, i) => ({
    seq: i + 1,
    tag,
    at: i * 1350,
    ...(tag === "MessageReceived"
      ? {
          message: {
            role: "user" as const,
            text: `Review ${thread.group.toLowerCase()}. Work as the ${thread.name.toLowerCase()} and report the result.`
          }
        }
      : tag === "TurnCompleted"
        ? {
            message: {
              role: "assistant" as const,
              text: `I completed the ${thread.name.toLowerCase()} task for ${thread.group.toLowerCase()}. The source checks pass. The parent thread can use this result.\n\nThis conversation is simulated.`
            }
          }
        : {}),
    detail:
      tag === "ModelCalled"
        ? "Simulated model request"
        : tag === "ChildCreated"
          ? "Delegated source verification"
          : tag === "ToolCalled"
            ? "workspace.read"
            : tag === "TurnFailed"
              ? "Simulated tool failure"
              : "Simulated event"
  }))
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid server record")
  return value as Record<string, unknown>
}
function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function parseThreads(value: unknown): Thread[] {
  if (!Array.isArray(value)) throw new Error("Expected a thread list")
  const seen = new Set<string>()
  return value.map((item: unknown) => {
    const row = record(item)
    const id = string(row.id)
    if (!id || seen.has(id))
      throw new Error("Missing or duplicate thread identifier")
    seen.add(id)
    const raw = string(row.status)
    const status: Status =
      raw === "settled"
        ? "settled"
        : raw === "blocked" || raw === "waiting"
          ? "waiting"
          : raw === "failed"
            ? "failed"
            : raw === "running" || raw === "ready" || raw === "driving"
              ? "running"
              : "unknown"
    return {
      id,
      parent: string(row.parent),
      name: id,
      group: "Live threads",
      status,
      events: number(row.events),
      lastAt: number(row.lastAt)
    }
  })
}

function conversation(event: Record<string, unknown>): Event["message"] {
  if (event.type === "MessageReceived") {
    const parts = Array.isArray(event.content)
      ? event.content
          .flatMap((part: unknown) => {
            if (!part || typeof part !== "object") return []
            const item = part as Record<string, unknown>
            return item.type === "text"
              ? [string(item.text)]
              : item.type === "file"
                ? ["[Attachment]"]
                : []
          })
          .join("\n")
      : string(event.text)
    return parts ? { role: "user", text: parts } : undefined
  }
  if (event.type === "TurnCompleted" && typeof event.output === "string")
    return { role: "assistant", text: event.output }
  return undefined
}

// parseEvents retains conversation text and omits request headers; data.test.ts checks the boundary.
export function parseEvents(value: unknown): Event[] {
  if (!Array.isArray(value)) throw new Error("Expected an event list")
  return value.map((item: unknown) => {
    const row = record(item)
    const event = record(row.event)
    const message = conversation(event)
    return {
      ...(message ? { message } : {}),
      seq: number(row.seq),
      tag: string(event.type, string(event._tag, "Event")),
      at: number(event.at),
      detail: string(event.tool, string(event.method, string(event.model)))
    }
  })
}

export async function getJson(
  path: string,
  requestMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const timeout = AbortSignal.timeout(requestMs)
  const response = await fetch(path, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw new Error(`Server returns HTTP ${response.status}`)
  return response.json()
}

export type Point = { x: number; y: number }
type Node = Thread & Point
export type Graph = { nodes: Node[]; width: number; height: number }

// layout places disconnected and cyclic records once; data.test.ts checks coverage and finite positions.
export function layout(threads: readonly Thread[]): Graph {
  const byId = new Map(threads.map((t) => [t.id, t]))
  const children = new Map<string, Thread[]>()
  for (const t of threads)
    children.set(t.parent, [...(children.get(t.parent) ?? []), t])
  const visited = new Set<string>()
  const nodes: Node[] = []
  const components: Node[][] = []
  const roots = [...threads.filter((t) => !byId.has(t.parent)), ...threads]
  for (const root of roots) {
    if (visited.has(root.id)) continue
    const component: Node[] = []
    const queue = [{ thread: root, depth: 0 }]
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { thread, depth } = queue[cursor]!
      if (visited.has(thread.id)) continue
      visited.add(thread.id)
      component.push({
        ...thread,
        x: depth * 228 + 40,
        y: component.length * 60 + 100
      })
      for (const child of children.get(thread.id) ?? [])
        if (!visited.has(child.id))
          queue.push({ thread: child, depth: depth + 1 })
    }
    components.push(component)
  }
  const cellWidth = Math.max(
    300,
    ...components.flatMap((c) => c.map((n) => n.x + 260))
  )
  const cellHeight = Math.max(
    240,
    ...components.map((c) => c.length * 60 + 160)
  )
  components.forEach((component, i) => {
    for (const node of component)
      nodes.push({
        ...node,
        x: node.x + (i % 4) * cellWidth,
        y: node.y + Math.floor(i / 4) * cellHeight
      })
  })
  return {
    nodes,
    width: Math.max(300, ...nodes.map((n) => n.x + 230)),
    height: Math.max(240, ...nodes.map((n) => n.y + 100))
  }
}
export function matches(
  thread: Thread,
  query: string,
  status: string
): boolean {
  return (
    (status === "all" || thread.status === status) &&
    `${thread.id} ${thread.name} ${thread.group}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )
}
export type Camera = { x: number; y: number; zoom: number }
export function zoomAt(camera: Camera, factor: number, point: Point): Camera {
  const zoom = Math.max(0.08, Math.min(2, camera.zoom * factor))
  return {
    zoom,
    x: point.x - ((point.x - camera.x) * zoom) / camera.zoom,
    y: point.y - ((point.y - camera.y) * zoom) / camera.zoom
  }
}
export function fit(graph: Graph, width: number, height: number): Camera {
  const zoom = Math.min(
    1,
    Math.max(
      0.08,
      Math.min((width - 80) / graph.width, (height - 80) / graph.height)
    )
  )
  return {
    zoom,
    x: (width - graph.width * zoom) / 2,
    y: (height - graph.height * zoom) / 2
  }
}
