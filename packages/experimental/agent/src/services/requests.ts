import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Context, Effect, Layer } from "effect"
import type { TaskExecution } from "@clavia/tardigrade-experimental-packages"
import type { BudgetDecision, Decision, ToolCall } from "../event"

export class PermissionRequests extends Context.Service<PermissionRequests, {
  readonly request: (call: typeof ToolCall.Type) => Effect.Effect<typeof Decision.Type, Error>
}>()("example/PermissionRequests") {}

export type BudgetRequest = {
  readonly callId: string
  readonly amount: number
  readonly reason: string
  readonly used: number
  readonly limit: number
}

export class BudgetRequests extends Context.Service<BudgetRequests, {
  readonly request: (request: BudgetRequest) => Effect.Effect<typeof BudgetDecision.Type, Error>
}>()("example/BudgetRequests") {}

// parentBudgetRequests translates a parent task reply into a budget decision without changing actor state.
export const parentBudgetRequests = (task: typeof TaskExecution.Service) => Layer.succeed(BudgetRequests, {
  request: request => Effect.gen(function* () {
    const decision = yield* task.request({
      requestId: request.callId, kind: "budget", description: request.reason,
      input: { amount: request.amount, used: request.used, limit: request.limit },
    })
    if (!decision.allowed) return { allowed: false, reason: decision.reason }
    if (decision.amount === undefined) return yield* Effect.fail(new RuntimeError("Budget grant omitted its amount"))
    return { allowed: true, additionalCalls: decision.amount }
  }),
})
