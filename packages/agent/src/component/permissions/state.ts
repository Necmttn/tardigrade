import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { HashMap, Option, Schema } from "effect"
import { eventAt, eventPositionOf, PositionedEvent, type Event } from "@clavia/tardigrade-core/event"
import { ActorInvocationContextSchema, actorInvocationContextFrom, invocationKey, invocationCoordinateKey } from "@clavia/tardigrade-core/interaction/invocation"
import { outgoingKey, terminalInvocationRefOf } from "@clavia/tardigrade-core/interaction/records-compat"

export const PermissionFactsSchema = Schema.Struct({
  position: Schema.Finite,
  thread: Schema.optionalKey(PositionedEvent),
  heads: Schema.HashMap(Schema.String, PositionedEvent),
  contexts: Schema.HashMap(Schema.String, ActorInvocationContextSchema),
  decisions: Schema.HashMap(Schema.String, PositionedEvent),
  plans: Schema.HashMap(Schema.String, PositionedEvent),
  dispatched: Schema.HashMap(Schema.String, PositionedEvent),
  terminals: Schema.HashMap(Schema.String, PositionedEvent)
})
export type PermissionFacts = typeof PermissionFactsSchema.Type

export const initialPermissionFacts = (): PermissionFacts => ({ position: 0, heads: HashMap.empty(), contexts: HashMap.empty(), decisions: HashMap.empty(), plans: HashMap.empty(), dispatched: HashMap.empty(), terminals: HashMap.empty() })

const first = <A>(values: HashMap.HashMap<string, A>, key: string, value: A) => HashMap.has(values, key) ? values : HashMap.set(values, key, value)
const requestId = (id: unknown): string | undefined => {
  if (typeof id !== "string") return undefined
  try {
    const parts: unknown = JSON.parse(id)
    return Array.isArray(parts) && parts.length === 2 && typeof parts[1] === "string" && parts[1].startsWith("permission/") ? parts[1] : undefined
  } catch { return undefined }
}
const decided = (decisions: PermissionFacts["decisions"], id: unknown): boolean => {
  const request = requestId(id)
  return request !== undefined && HashMap.has(decisions, request)
}

export const reducePermissionFacts = (state: PermissionFacts, input: Event): PermissionFacts => {
  const position = state.position + 1
  const event = eventPositionOf(input) === undefined ? eventAt(input, position) : input
  const context = actorInvocationContextFrom(event)
  const contexts = context === undefined ? state.contexts : first(state.contexts, invocationKey(context.invocation), context)
  const decisions = event.type === "PermissionRequestDecided" || event.type === "PermissionRequestFailed"
    ? first(state.decisions, String(event.callId), event) : state.decisions
  let plans = state.plans
  let dispatched = state.dispatched
  let terminals = state.terminals
  if (requestId(event.id) !== undefined && !decided(decisions, event.id)) {
    if (event.type === "CallPlanned") plans = first(plans, outgoingKey(event), event)
    if (event.type === "CallDispatched") dispatched = first(dispatched, outgoingKey(event), event)
  }
  const reference = terminalInvocationRefOf(event)
  if (reference?.invocation.method === "requestPermission" && !decided(decisions, reference.invocation.id)) terminals = first(terminals, invocationCoordinateKey(reference), event)
  if (decisions !== state.decisions) {
    plans = HashMap.filter(plans, event => !decided(decisions, event.id))
    dispatched = HashMap.filter(dispatched, event => !decided(decisions, event.id))
    terminals = HashMap.filter(terminals, event => !decided(decisions, terminalInvocationRefOf(event)?.invocation.id))
  }
  const head: Event = { type: "MessageReceived", id: event.id, ...(event.link === undefined ? {} : { link: event.link }) }
  return {
    position, contexts, decisions, plans, dispatched, terminals,
    ...(state.position === 0 && threadCreatedOf([event]) !== undefined ? { thread: event } : state.thread === undefined ? {} : { thread: state.thread }),
    heads: event.type === "MessageReceived" ? first(state.heads, String(event.id), head) : state.heads
  }
}

export const permissionCallEvidence = (state: PermissionFacts, id: string): ReadonlyArray<Event> => [
  ...HashMap.values(state.plans), ...HashMap.values(state.dispatched), ...HashMap.values(state.terminals)
].filter(event => event.id === id || terminalInvocationRefOf(event)?.invocation.id === id)
  .sort((left, right) => (eventPositionOf(left) ?? 0) - (eventPositionOf(right) ?? 0))

export const permissionDecision = (state: PermissionFacts, id: string): Event | undefined => Option.getOrUndefined(HashMap.get(state.decisions, id))
