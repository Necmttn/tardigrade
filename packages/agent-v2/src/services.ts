import type { ClippedInput } from "./context"
import { Context, type Effect } from "effect"
import type { AgentEvent, Decision, ModelReply, ToolCall, ToolSpec } from "./events"

export interface ModelContext {
  readonly clipped: readonly ClippedInput[]
  readonly system: string
  readonly summary: string
  readonly events: readonly AgentEvent[]
  readonly tools: readonly ToolSpec[]
}
export class Model extends Context.Service<Model, {
  readonly call: (context: ModelContext) => Effect.Effect<ModelReply, Error>
}>()("tardigrade/agent-v2/Model") {}
export class Summarizer extends Context.Service<Summarizer, {
  readonly summarize: (input: { readonly events: readonly AgentEvent[]; readonly clipped: readonly ClippedInput[] }) => Effect.Effect<string, Error>
}>()("tardigrade/agent-v2/Summarizer") {}
export class PermissionChecker extends Context.Service<PermissionChecker, {
  readonly check: (call: ToolCall) => Effect.Effect<Decision, Error>
}>()("tardigrade/agent-v2/PermissionChecker") {}
export class ToolExecutor extends Context.Service<ToolExecutor, {
  readonly execute: (call: ToolCall) => Effect.Effect<unknown, Error>
}>()("tardigrade/agent-v2/ToolExecutor") {}
