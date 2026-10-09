import type { Event, Thread } from "./data"

export type WakeKind = "message" | "alarm" | "response"
const incoming = new Set([
  "MessageReceived",
  "AlarmFired",
  "ResponseReceived",
  "CallTimedOut"
])
const activity = new Set([
  "ModelCalled",
  "ToolCalled",
  "CodeDispatched",
  "TurnCompleted",
  "TurnFailed"
])

// arrivals distinguishes explicit turn links from sequence order; activity.test.ts checks both cases.
export function arrivals(events: readonly Event[]) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  return ordered.flatMap((event, i) => {
    if (!incoming.has(event.tag)) return []
    const later = ordered.slice(i + 1)
    const linked =
      event.tag === "MessageReceived" && event.receiptId
        ? later.find(
            (next) => activity.has(next.tag) && next.turn === event.receiptId
          )
        : undefined
    const boundary = later.findIndex((next) => incoming.has(next.tag))
    const next =
      linked ??
      later
        .slice(0, boundary < 0 ? undefined : boundary)
        .find((next) => activity.has(next.tag))
    return [
      {
        event,
        next,
        linked: Boolean(linked),
        source:
          event.source ||
          (event.tag === "AlarmFired"
            ? "Platform alarm"
            : event.tag === "ResponseReceived"
              ? "Actor response"
              : event.tag === "CallTimedOut"
                ? "Call deadline"
                : "Incoming message")
      }
    ]
  })
}

export function demoWake(
  thread: Thread,
  kind: WakeKind,
  step: number
): Event[] {
  const source =
    kind === "message"
      ? "Webhook"
      : kind === "alarm"
        ? "Platform alarm"
        : "Child response"
  const tag =
    kind === "message"
      ? "MessageReceived"
      : kind === "alarm"
        ? "AlarmFired"
        : "ResponseReceived"
  const turn = `demo-wake-${thread.id}`
  const events: Event[] = [
    {
      seq: 1,
      tag: "BlockedOn",
      at: 1000,
      detail: `Waiting for ${source.toLowerCase()}`
    }
  ]
  if (step >= 1)
    events.push({
      seq: 2,
      tag,
      at: 6000,
      detail: "Simulated delivery",
      source,
      receiptId: turn,
      ...(kind === "message"
        ? {
            message: {
              role: "user",
              text: "A new external record is available. Review it and report the result."
            }
          }
        : {})
    })
  if (step >= 2)
    events.push({
      seq: 3,
      tag: "ModelCalled",
      at: 6250,
      detail: "Simulated activation",
      turn
    })
  if (step >= 3)
    events.push({
      seq: 4,
      tag: "TurnCompleted",
      at: 8400,
      detail: "Simulated completion",
      turn,
      message: {
        role: "assistant",
        text: "I reviewed the new record and completed the work. This is a simulated response."
      }
    })
  return events
}
