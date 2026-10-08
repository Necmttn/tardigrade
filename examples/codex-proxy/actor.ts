import { Effect, Schema } from "effect"
import { Rpc } from "effect/unstable/rpc"
import { atom, defineActor } from "tardie/core"
import { agentMethods, compact, infer, messages, tools as libraryTools } from "tardie/agent"
import { defineLibrary, MethodDescription } from "tardie/libraries"

export const clock = defineLibrary({
  name: "clock",
  description: "Current time",
  toolNames: { now: "current_time" },
  methods: [Rpc.make("now", { payload: Schema.Struct({}), success: Schema.String })
    .annotate(MethodDescription, "Read the current time in UTC")]
})

export default defineActor("codex", Effect.gen(function* () {
  const system = atom("Use the current_time tool when asked for the time. Keep answers short.")
  const tools = yield* libraryTools([clock])
  const context = yield* compact(messages)
  const agent = yield* infer(get => ({ system: get(system), tools: get(tools), context: get(context) }))
  return { atom: agent, methods: agentMethods }
}))
