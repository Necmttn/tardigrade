import type { AgentEvent, ToolCall, Decision } from "./events"
import { requestEvent } from "./events"

export const trajectoryState = (events: readonly AgentEvent[]) => ({ events, revision: events.length })
export function currentTurn(events: readonly AgentEvent[]) {
  const index = events.findLastIndex(event => event.type === "MessageReceived")
  return index < 0 ? [] : events.slice(index)
}
export function pendingTools(events: readonly AgentEvent[]): readonly ToolCall[] {
  const turn = currentTurn(events)
  return turn.flatMap(event => event.type === "ModelReturned" ? event.reply.toolCalls : [])
    .filter(call => !turn.some(event => event.type === "ToolReturned" && event.callId === call.callId))
}
export function outstanding(events: readonly AgentEvent[]) {
  return events.filter(requestEvent).filter(request => !events.some(event =>
    "callId" in event && event.callId === request.callId && (
      event.type === "EffectFailed" ||
      request.type === "ModelCalled" && event.type === "ModelReturned" ||
      request.type === "ToolCalled" && event.type === "ToolReturned" ||
      request.type === "PermissionRequested" && event.type === "PermissionResolved" ||
      request.type === "SummaryRequested" && event.type === "SummaryReturned"
    )))
}
export const toolUsage = (events: readonly AgentEvent[]) => currentTurn(events).filter(event => event.type === "ToolCalled" && event.decision.allowed).length
export const inferenceUsage = (events: readonly AgentEvent[]) => currentTurn(events).reduce((sum, event) => sum + (event.type === "ModelReturned" ? event.reply.cost : 0), 0)
export function toolDecisions(events: readonly AgentEvent[]): Readonly<Record<string, Decision>> {
  return Object.fromEntries(events.filter(event => event.type === "PermissionResolved").map(event => [event.callId, event.decision]))
}
export function inferState(events: readonly AgentEvent[]) {
  const turn = currentTurn(events)
  const message = turn[0]
  const latest = turn.findLast(event => event.type === "ModelReturned")
  return {
    revision: events.length,
    turnId: message?.type === "MessageReceived" ? message.turnId : "",
    callId: `model:${events.length}`,
    needed: message !== undefined && (!latest || latest.reply.toolCalls.length > 0) && pendingTools(events).length === 0,
    blocked: outstanding(events).length > 0 || turn.some(event => event.type === "EffectFailed"),
  }
}
