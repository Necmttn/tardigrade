import { ToolError } from "./errors"
import { TaskExecution, TaskRuntime } from "./task"
import { Effect, Layer, Schema } from "effect"
import { Context } from "effect"
import type { ToolCall, ToolSpec, ExecutionMode } from "./types"

export interface ToolInvocation extends ToolCall {
  readonly parentCallId?: string
}

export interface AgentTool<R = never> {
  readonly spec: ToolSpec
  readonly execute: (input: unknown, call: ToolInvocation) => Effect.Effect<unknown, Error, R>
}

export const DEFAULT_TOOL_EXECUTION = "sync" as const

interface ToolOptions<Input, R> {
  readonly name: string
  readonly description: string
  readonly input: Schema.ConstraintDecoder<Input>
  readonly run: (input: Input, call: ToolInvocation) => Effect.Effect<unknown, Error, R>
}

// tool executes its handler in the mode declared by its definition.
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution?: "sync" }): AgentTool<R>
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution: "async" }): AgentTool<R | TaskRuntime>
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution?: ExecutionMode }): AgentTool<R | TaskRuntime> {
  const execution = options.execution ?? DEFAULT_TOOL_EXECUTION
  return {
    spec: { name: options.name, description: options.description, inputSchema: Schema.toJsonSchemaDocument(options.input).schema, execution },
    execute: (input, call) => Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(input).pipe(Effect.mapError(ToolError.from))
      if (execution === "sync") return yield* options.run(value, call)
      const context = yield* Effect.context<R>()
      const runtime = yield* TaskRuntime
      return yield* runtime.start(call, options.run(value, call).pipe(Effect.provide(context)))
    }),
  }
}

// toolLayer captures tool services and routes calls by registered name.
export function toolLayer<R>(tools: readonly AgentTool<R>[]) {
  const registry = new Map(tools.map(tool => [tool.spec.name, tool]))
  if (registry.size !== tools.length) throw new ToolError("Duplicate tool name")
  return Layer.effect(ToolExecutor, Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    return {
      execute: (call: ToolCall) => {
        const handler = registry.get(call.name)
        return handler
          ? handler.execute(call.input, call).pipe(Effect.provide(context))
          : Effect.fail(new ToolError(`Unknown tool: ${call.name}`))
      },
    }
  }))
}

// asyncTool starts a correlated task and returns its reference before the handler completes.
export function asyncTool<Input, R>(options: {
  readonly name: string
  readonly description: string
  readonly input: Schema.ConstraintDecoder<Input>
  readonly run: (input: Input, task: typeof TaskExecution.Service) => Effect.Effect<unknown, Error, R>
}): AgentTool<R | TaskRuntime> {
  return {
    spec: { name: options.name, description: options.description, inputSchema: Schema.toJsonSchemaDocument(options.input).schema, execution: "async" },
    execute: (input, call) => Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(input).pipe(Effect.mapError(ToolError.from))
      const context = yield* Effect.context<R>()
      const runtime = yield* TaskRuntime
      return yield* runtime.start(call, Effect.gen(function* () {
        const task = yield* TaskExecution
        return yield* options.run(value, task).pipe(Effect.provide(context))
      }))
    }),
  }
}

export class ToolExecutor extends Context.Service<ToolExecutor, {
  readonly execute: (call: ToolCall) => Effect.Effect<unknown, Error>
}>()("tardigrade/experimental/packages/ToolExecutor") {}
