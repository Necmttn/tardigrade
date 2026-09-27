import { Context, Effect, Schema } from "effect"
import type { ToolInvocation } from "./tool"

export const TaskDecision = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true), amount: Schema.optionalKey(Schema.Finite) }),
  Schema.Struct({ allowed: Schema.Literal(false), reason: Schema.String }),
])
export type TaskDecision = typeof TaskDecision.Type
export const TaskRequest = Schema.Struct({
  requestId: Schema.String,
  kind: Schema.Literals(["permission", "budget"]),
  description: Schema.String,
  input: Schema.Unknown,
})
export type TaskRequest = typeof TaskRequest.Type
export class TaskExecution extends Context.Service<TaskExecution, {
  readonly taskId: string
  readonly notify: (message: unknown) => Effect.Effect<void, Error>
  readonly request: (request: TaskRequest) => Effect.Effect<TaskDecision, Error>
}>()("tardigrade/experimental/packages/TaskExecution") {}
export class TaskRuntime extends Context.Service<TaskRuntime, {
  readonly start: (call: ToolInvocation, run: Effect.Effect<unknown, Error, TaskExecution>) => Effect.Effect<{ readonly taskId: string }, Error>
  readonly reply: (taskId: string, requestId: string, decision: TaskDecision) => Effect.Effect<void, Error>
  readonly cancel: (taskId: string) => Effect.Effect<void, Error>
}>()("tardigrade/experimental/packages/TaskRuntime") {}
