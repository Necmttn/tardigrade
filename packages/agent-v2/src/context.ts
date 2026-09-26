import { Schema } from "effect"
import type { AgentEvent } from "./events"

export const DEFAULT_MAX_INPUT_CHARS = 16_000
export const ClippedInput = Schema.Struct({
  eventIndex: Schema.Number,
  field: Schema.String,
  originalChars: Schema.Number,
  maxInputChars: Schema.Number,
})
export type ClippedInput = typeof ClippedInput.Type

// boundedInputs clips context payloads while preserving event identities and call/result links.
export function boundedInputs(events: readonly AgentEvent[], maxInputChars: number) {
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 1) throw new Error("maxInputChars must be a positive integer")
  const clipped: ClippedInput[] = []
  const text = (value: string, eventIndex: number, field: string) => {
    if (value.length <= maxInputChars) return value
    clipped.push({ eventIndex, field, originalChars: value.length, maxInputChars })
    return value.slice(0, maxInputChars)
  }
  const payload = (value: unknown, eventIndex: number, field: string): unknown => {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || serialized.length <= maxInputChars) return value
    return { truncated: true, originalChars: serialized.length, maxInputChars, text: text(serialized, eventIndex, field) }
  }
  return {
    clipped,
    events: events.map((event, index): AgentEvent => {
      switch (event.type) {
        case "MessageReceived": return { ...event, message: text(event.message, index, "message") }
        case "ModelReturned": return { ...event, reply: { ...event.reply,
          message: text(event.reply.message, index, "reply.message"),
          toolCalls: event.reply.toolCalls.map((call, i) => ({ ...call, input: payload(call.input, index, `reply.toolCalls[${i}].input`) })),
        } }
        case "ToolReturned": return { ...event, output: payload(event.output, index, "output"), error: event.error === null ? null : text(event.error, index, "error") }
        case "ToolCalled":
        case "PermissionRequested": return { ...event, input: payload(event.input, index, "input") }
        case "SummaryReturned": return { ...event, summary: text(event.summary, index, "summary") }
        case "EffectFailed": return { ...event, message: text(event.message, index, "message") }
        default: return event
      }
    }),
  }
}
