import { ModelRef } from "@clavia/tardigrade-model/reference"
import { Schema } from "effect"
import { Alarm, TaskRequest, TaskDecision } from "@clavia/tardigrade-experimental-packages"

export const AlarmSet = Schema.Struct({ type: Schema.Literal("AlarmSet"), alarm: Alarm })
export const AlarmCancelled = Schema.Struct({ type: Schema.Literal("AlarmCancelled"), alarmId: Schema.NonEmptyString })
export const AlarmRang = Schema.Struct({ type: Schema.Literal("AlarmRang"), alarmId: Schema.NonEmptyString })

export const ToolCall = Schema.Struct({ callId: Schema.String, name: Schema.String, input: Schema.Unknown })
export const Decision = Schema.Struct({ allowed: Schema.Boolean, reason: Schema.String })

export const BudgetDecision = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true), additionalCalls: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) }),
  Schema.Struct({ allowed: Schema.Literal(false), reason: Schema.String }),
])

export const BudgetRequested = Schema.Struct({ type: Schema.Literal("BudgetRequested"), callId: Schema.String, amount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)), reason: Schema.NonEmptyString })

export const BudgetResolved = Schema.Struct({ type: Schema.Literal("BudgetResolved"), callId: Schema.String, decision: BudgetDecision })
export type BudgetResolved = typeof BudgetResolved.Type

export const TaskStarted = Schema.Struct({ type: Schema.Literal("TaskStarted"), taskId: Schema.String, callId: Schema.String, name: Schema.String })
export type TaskStarted = typeof TaskStarted.Type

export const TaskSettled = Schema.Struct({ type: Schema.Literal("TaskSettled"), taskId: Schema.String, output: Schema.String, error: Schema.NullOr(Schema.String) })
export type TaskSettled = typeof TaskSettled.Type

export const PermissionRequested = Schema.Struct({ type: Schema.Literal("PermissionRequested"), callId: Schema.String })
export type PermissionRequested = typeof PermissionRequested.Type

export const PermissionResolved = Schema.Struct({ type: Schema.Literal("PermissionResolved"), callId: Schema.String, decision: Decision })
export type PermissionResolved = typeof PermissionResolved.Type

export const ToolCalled = Schema.Struct({ type: Schema.Literal("ToolCalled"), callId: Schema.String, charged: Schema.Boolean })
export type ToolCalled = typeof ToolCalled.Type

export const ToolReturned = Schema.Struct({ type: Schema.Literal("ToolReturned"), callId: Schema.String, output: Schema.String, error: Schema.NullOr(Schema.String) })
export type ToolReturned = typeof ToolReturned.Type

export const MessageReceived = Schema.Union([
  Schema.Struct({ type: Schema.Literal("MessageReceived"), kind: Schema.Literal("message"), turnId: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("MessageReceived"), kind: Schema.Literal("request"), taskId: Schema.String, request: TaskRequest }),
  Schema.Struct({ type: Schema.Literal("MessageReceived"), kind: Schema.Literal("reply"), taskId: Schema.String, requestId: Schema.String, decision: TaskDecision }),
])
export type MessageReceived = typeof MessageReceived.Type

const ModelMetadata = {
  model: ModelRef,
  contextWindowTokens: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
}

export const ModelCalled = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ModelCalled"), purpose: Schema.Literal("inference"), ...ModelMetadata, turnId: Schema.String, callId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ModelCalled"), purpose: Schema.Literal("compaction"), ...ModelMetadata, callId: Schema.String, through: Schema.Finite }),
])
export type ModelCalled = typeof ModelCalled.Type

export const ModelReturned = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("inference"), callId: Schema.String, text: Schema.String, toolCalls: Schema.Array(ToolCall) }),
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("compaction"), callId: Schema.String, text: Schema.String }),
])
export type ModelReturned = typeof ModelReturned.Type

export const TurnSettled = Schema.Union([
  Schema.Struct({ type: Schema.Literal("TurnSettled"), turnId: Schema.String, outcome: Schema.Literal("completed"), output: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TurnSettled"), turnId: Schema.String, outcome: Schema.Literals(["failed", "cancelled"]), reason: Schema.String }),
])
export type TurnSettled = typeof TurnSettled.Type

export const Event = Schema.Union([
  AlarmSet,
  AlarmCancelled,
  AlarmRang,
  BudgetRequested,
  BudgetResolved,
  TaskStarted,
  TaskSettled,
  PermissionRequested,
  PermissionResolved,
  ToolCalled,
  ToolReturned,
  MessageReceived,
  ModelCalled,
  ModelReturned,
  TurnSettled,
])
export type Event = typeof Event.Type

export const message = (input: { readonly text: string; readonly turnId?: string }): MessageReceived =>
  ({ type: "MessageReceived", kind: "message", turnId: input.turnId ?? crypto.randomUUID(), text: input.text })

export const resolveBudget = (callId: string, decision: typeof BudgetDecision.Type): BudgetResolved =>
  ({ type: "BudgetResolved", callId, decision })

export const resolvePermission = (callId: string, decision: typeof Decision.Type): PermissionResolved =>
  ({ type: "PermissionResolved", callId, decision })
