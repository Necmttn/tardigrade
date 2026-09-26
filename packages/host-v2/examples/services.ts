import { exampleTools } from "./tools"
import { Effect, Layer } from "effect"
import { Model, PermissionChecker, Summarizer, toolLayer } from "@clavia/tardigrade-agent-v2"

export const services = Layer.mergeAll(
  Layer.succeed(Model, {
    call: context => Effect.succeed(context.events.some(event => event.type === "ToolReturned")
      ? { message: "2 + 3 = 5", cost: 0.01, toolCalls: [] }
      : { message: "", cost: 0.01, toolCalls: [{ callId: "provider:1", name: "add", input: { a: 2, b: 3 } }] }),
  }),
  Layer.succeed(PermissionChecker, { check: () => Effect.succeed({ allowed: true }) }),
  Layer.succeed(Summarizer, { summarize: ({ events }) => Effect.succeed(`Earlier conversation: ${events.length} events.`) }),
  toolLayer(exampleTools),
)
