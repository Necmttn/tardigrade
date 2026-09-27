import { Effect, Schema } from "effect"
import { TaskRuntime, tool } from "@clavia/tardigrade-experimental-packages"

const Amount = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const BudgetRequestInput = Schema.Struct({ amount: Amount, reason: Schema.NonEmptyString })

export const requestBudget = {
  spec: {
    name: "request_budget",
    description: "Request additional tool calls when your budget is exhausted. Waits for a decision and consumes no tool budget.",
    inputSchema: Schema.toJsonSchemaDocument(BudgetRequestInput).schema,
    execution: "sync" as const,
  },
}

export const grantBudget = tool({
  name: "grant_budget",
  description: "Grant additional tool calls to a child with an outstanding budget request. Use taskId and requestId from its message. This grant does not consume tool budget.",
  input: Schema.Struct({ taskId: Schema.NonEmptyString, requestId: Schema.NonEmptyString, amount: Amount }),
  run: ({ taskId, requestId, amount }) => Effect.gen(function* () {
    const runtime = yield* TaskRuntime
    yield* runtime.reply(taskId, requestId, { allowed: true, amount })
    return { taskId, requestId, granted: amount }
  }),
})
