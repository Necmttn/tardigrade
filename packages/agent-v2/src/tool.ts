import { Effect, Layer, Schema } from "effect"
import { ToolExecutor } from "./services"
import type { ToolCall, ToolSpec } from "./events"

export interface AgentTool<R = never> {
  readonly spec: ToolSpec
  readonly execute: (input: unknown) => Effect.Effect<unknown, Error, R>
}

// tool decodes external input before invoking a typed handler.
export function tool<Input, R>(options: {
  readonly name: string
  readonly description: string
  readonly input: Schema.ConstraintDecoder<Input>
  readonly run: (input: Input) => Effect.Effect<unknown, Error, R>
}): AgentTool<R> {
  return {
    spec: { name: options.name, description: options.description, inputSchema: Schema.toJsonSchemaDocument(options.input).schema },
    execute: input => Effect.try({
      try: () => Schema.decodeUnknownSync(options.input, { onExcessProperty: "error" })(input),
      catch: error => new Error(String(error)),
    }).pipe(Effect.flatMap(options.run)),
  }
}

// toolLayer captures tool services and routes calls by registered name.
export function toolLayer<R>(tools: readonly AgentTool<R>[]) {
  const registry = new Map(tools.map(tool => [tool.spec.name, tool]))
  if (registry.size !== tools.length) throw new Error("Duplicate tool name")
  return Layer.effect(ToolExecutor, Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    return {
      execute: (call: ToolCall) => {
        const handler = registry.get(call.name)
        return handler
          ? handler.execute(call.input).pipe(Effect.provide(context))
          : Effect.fail(new Error(`Unknown tool: ${call.name}`))
      },
    }
  }))
}
