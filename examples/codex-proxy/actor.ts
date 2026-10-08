import { Clock, Effect } from "effect"
import { defineActor } from "tardie/core"
import { agentMethods, infer, nativeOutput, system, tool } from "tardie/agent"

const currentTime = tool({
  spec: {
    name: "current_time",
    description: "Read the current time in UTC.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  run: () => Effect.map(Clock.currentTimeMillis, (now) => new Date(now).toISOString())
})

export default defineActor("codex", agentMethods, [
  infer([
    system("Use the current_time tool when asked for the time. Keep answers short."),
    currentTime,
    nativeOutput
  ])
])
