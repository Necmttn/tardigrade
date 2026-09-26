import type { InferState } from "./machines"
import type { AgentEvent, AgentInput } from "./events"
import { currentTurn, outstanding } from "./projections"

// agentOutcome interprets recorded agent events without defining an actor composition.
export function agentOutcome(input: readonly AgentInput[], view?: { readonly children: { readonly permissions?: { readonly mode: "manual" | "automatic" }; readonly infer: { readonly value: typeof InferState.Type } } }) {
  const events = input.filter((event): event is AgentEvent => event.type !== "ActorMethodInvoked")
  const turn = currentTurn(events)
  const failure = turn.findLast(event => event.type === "EffectFailed")
  if (failure?.type === "EffectFailed") return { status: "failed" as const, message: failure.message }
  const pending = outstanding(events)
  if (pending.length && pending.every(event => event.type === "PermissionRequested") && view?.children.permissions?.mode === "manual") {
    return { status: "waiting" as const, message: `Awaiting permission: ${pending.map(event => event.callId).join(", ")}` }
  }
  if (pending.length) return { status: "interrupted" as const, message: `Unfinished requests require reconciliation: ${pending.map(event => event.callId).join(", ")}` }
  const reply = turn.findLast(event => event.type === "ModelReturned")
  if (reply?.type === "ModelReturned" && reply.reply.toolCalls.length === 0) return { status: "complete" as const, message: reply.reply.message }
  const inference = view?.children.infer.value
  if (inference?.permission && !inference.permission.allowed) {
    return { status: "blocked" as const, message: inference.permission.reason }
  }
  if (inference && !inference.context?.ready) {
    return { status: "blocked" as const, message: "Bounded context is unavailable; inspect the compaction limit and pending summary." }
  }
  return { status: "blocked" as const, message: "No final response; inspect machine views for context or permission constraints" }
}
