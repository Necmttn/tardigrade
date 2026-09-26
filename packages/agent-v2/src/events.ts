import { Schema } from "effect"

export const ToolCall = Schema.Struct({ callId: Schema.String, name: Schema.String, input: Schema.Unknown })
export type ToolCall = typeof ToolCall.Type
export const Decision = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true) }),
  Schema.Struct({ allowed: Schema.Literal(false), reason: Schema.String }),
])
export type Decision = typeof Decision.Type
export const ToolSpec = Schema.Struct({ name: Schema.String, description: Schema.String, inputSchema: Schema.Unknown })
export type ToolSpec = typeof ToolSpec.Type
export const ModelReply = Schema.Struct({ message: Schema.String, cost: Schema.Number, toolCalls: Schema.Array(ToolCall) })
export type ModelReply = typeof ModelReply.Type

export const AgentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("MessageReceived"), turnId: Schema.String, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ModelCalled"), callId: Schema.String, turnId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ModelReturned"), callId: Schema.String, reply: ModelReply }),
  Schema.Struct({ type: Schema.Literal("ToolCalled"), ...ToolCall.fields, decision: Decision }),
  Schema.Struct({ type: Schema.Literal("ToolReturned"), callId: Schema.String, output: Schema.Unknown, error: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("PermissionRequested"), ...ToolCall.fields }),
  Schema.Struct({ type: Schema.Literal("PermissionResolved"), callId: Schema.String, decision: Decision }),
  Schema.Struct({ type: Schema.Literal("SummaryRequested"), callId: Schema.String, covered: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("SummaryReturned"), callId: Schema.String, summary: Schema.String }),
  Schema.Struct({ type: Schema.Literal("EffectFailed"), callId: Schema.String, message: Schema.String }),
])
export type AgentEvent = typeof AgentEvent.Type
export type RequestEvent = Extract<AgentEvent, { type: "ModelCalled" | "ToolCalled" | "PermissionRequested" | "SummaryRequested" }>
export const requestEvent = (event: AgentEvent): event is RequestEvent =>
  event.type === "ModelCalled" || event.type === "ToolCalled" || event.type === "PermissionRequested" || event.type === "SummaryRequested"

export const PermissionDecisionInput = Schema.Struct({ callId: Schema.String, decision: Decision })
export const AgentInput = Schema.Union([
  AgentEvent,
  Schema.Struct({ type: Schema.Literal("ActorMethodInvoked"), method: Schema.Literal("resolvePermission"), input: PermissionDecisionInput }),
])
export type AgentInput = typeof AgentInput.Type
