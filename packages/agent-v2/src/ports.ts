import { ClippedInput } from "./context"
import { Schema } from "effect"
import { interaction } from "@clavia/tardigrade-core-v2"
import { AgentEvent, Decision, ToolSpec } from "./events"

export const Conversation = Schema.Struct({ events: Schema.Array(AgentEvent), revision: Schema.Number })
export const ContextView = Schema.Struct({ ...Conversation.fields, summary: Schema.String, ready: Schema.Boolean, clipped: Schema.Array(ClippedInput), maxInputChars: Schema.Number })
export const PermissionView = Schema.Struct({ revision: Schema.Number, decisions: Schema.Record(Schema.String, Decision) })
export const Trajectory = interaction<typeof Conversation.Type>("Trajectory")
export const BoundedContext = interaction<typeof ContextView.Type>("BoundedContext")
export const SystemPrompt = interaction<string>("SystemPrompt")
export const AvailableTools = interaction<readonly typeof ToolSpec.Type[]>("AvailableTools")
export const ToolPermission = interaction<typeof PermissionView.Type>("ToolPermission")
export const ToolBudget = interaction<typeof PermissionView.Type>("ToolBudget")
export const InferBudget = interaction<typeof Decision.Type>("InferBudget")

export const ResolvePermission = interaction<{ readonly callId: string; readonly decision: typeof Decision.Type }>("ResolvePermission")
