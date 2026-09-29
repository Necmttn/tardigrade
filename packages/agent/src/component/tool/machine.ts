import type { ToolInteractions } from "../view"
import { type AgentComponent, type AgentView } from "../view"
import { annotateTransition, bindTransitionContext, executionOnly, type TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { RecordedEvent, eventAt, eventPositionOf } from "@clavia/tardigrade-core/event"
import { type Transition, type Intent } from "@clavia/tardigrade-core/runtime"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { toolCallPosition, toolResultPosition } from "../../log/tool"
import { toolReturned } from "../../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnTerminalOf } from "@clavia/tardigrade-code/execution/turns"
import { eventEpochOf } from "@clavia/tardigrade-code/execution/turns"
import type { InvocationCancellation } from "@clavia/tardigrade-core/interaction/events"
import type { Component } from "@clavia/tardigrade-core/actor"
import { component as defineComponent, withResponse, type ChildOf, type ComponentOutput, type ComponentOutputContext } from "@clavia/tardigrade-core/actor"
import { Chunk, HashMap, Option, Schema } from "effect"
import {
  initialTurnProjection,
  reduceTurnProjection,
  turnViewFrom,
  TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"

// ToolConcurrency limits admitted calls while the remaining calls stay pending (../../runtime/batches.test.ts).
export type ToolConcurrency = number | "unbounded"

// DEFAULT_TOOL_CONCURRENCY admits every pending call unless the consumer supplies a limit.
export const DEFAULT_TOOL_CONCURRENCY: ToolConcurrency = "unbounded"

// toolConcurrencyOf validates the dispatch limit at construction.
export const toolConcurrencyOf = (value: ToolConcurrency = DEFAULT_TOOL_CONCURRENCY): ToolConcurrency => {
  if (value !== "unbounded" && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error("tool concurrency must be a positive safe integer or unbounded")
  }
  return value
}

// toolConcurrencyInstruction describes the queue policy applied to model requests.
export const toolConcurrencyInstruction = (value: ToolConcurrency): string =>
  value === "unbounded" ? "" : `Tool execution admits at most ${value} pending call${value === 1 ? "" : "s"} at a time. Additional calls wait in order and each receives a result.`

const admitted = <T>(
  records: ReadonlyArray<T>,
  concurrency: ToolConcurrency,
  callOf: (record: T) => Pick<PendingCall, "name">,
  limitOf: (record: T) => ToolConcurrency | undefined
): ReadonlyArray<T> => {
  const counts = new Map<string, number>()
  const selected: T[] = []
  for (const record of records) {
    if (concurrency !== "unbounded" && selected.length >= concurrency) break
    const name = callOf(record).name
    const count = counts.get(name) ?? 0
    const limit = toolConcurrencyOf(limitOf(record))
    if (limit !== "unbounded" && count >= limit) continue
    counts.set(name, count + 1)
    selected.push(record)
  }
  return selected
}

// PendingCall identifies an unanswered ToolCalled event.
export interface PendingCall {
  readonly callId: string
  readonly position: number
  readonly validationError?: string
  readonly context: TransitionContext
  readonly name: string
  readonly arguments: unknown
  readonly turn?: string
  readonly epoch?: number
}

// Answer constructs the intent that records a tool result under the pending call's key.
export type Answer = (result: unknown) => Intent<never>

// Serve returns transitions for one call, an empty array while work remains pending, or undefined
// when the derived tool view does not contain the call.
export type Serve<R = never> = (
  call: PendingCall,
  log: ReadonlyArray<Event>,
  answer: Answer
) => ReadonlyArray<Transition<never, R>> | undefined

const positioned = (log: ReadonlyArray<Event>): ReadonlyArray<Event> => log.map((event, index) => eventPositionOf(event) === undefined ? eventAt(event, index + 1) : event)
const contextFor = (event: Event): TransitionContext => bindTransitionContext(event, "agent.tools")

const str = (v: unknown): string => String(v ?? "")

// pendingCalls returns unanswered calls in recorded order.
const pendingCalls = (log: ReadonlyArray<Event>): ReadonlyArray<PendingCall> => {
  const answered = new Set(log.filter((e) => e.type === "ToolReturned").map(toolResultPosition))
  return log.filter((e) => {
    if (e.type !== "ToolCalled" || answered.has(toolCallPosition(e))) return false
    return e.turn === undefined || turnTerminalOf(log, String(e.turn)) === undefined
  }).map((event) => ({
    callId: str(event.callId),
    position: toolCallPosition(event),
    ...(typeof event.validationError === "string" ? { validationError: event.validationError } : {}),
    context: contextFor(event),
    name: str(event.name),
    arguments: event.arguments,
    ...(event.turn === undefined ? {} : { turn: str(event.turn) }),
    ...(typeof event.epoch === "number" ? { epoch: event.epoch } : {})
  }))
}

const unknownToolError = (name: string, offered: ReadonlyArray<{ readonly name: string }>): string => {
  const available = offered.map((tool) => tool.name)
  if (name.includes(".") && available.includes("execute")) {
    return `unknown tool: ${name}. Package methods run inside execute. Call execute with JavaScript such as \`return await ${name}({...})\`.`
  }
  return `unknown tool: ${name}. Call one of: ${available.join(", ")}.`
}

// toolsReactorFrom routes admitted pending calls through their derived tool views.
export const toolsReactorFrom = <R = never>(
  serve: Serve<R>,
  toolsFor: (log: ReadonlyArray<Event>, call: PendingCall) => ReadonlyArray<{ readonly name: string; readonly concurrency?: ToolConcurrency }>,
  concurrency: ToolConcurrency = DEFAULT_TOOL_CONCURRENCY
): CompleteTransitionDerivation<R> => {
  const limit = toolConcurrencyOf(concurrency)
  return (history) => {
    const log = positioned(history)
    return admitted(pendingCalls(log), limit, (call) => call,
      (call) => toolsFor(log, call).find((tool) => tool.name === call.name)?.concurrency
    ).flatMap((call) => {
      const stamp = call.turn === undefined ? {} : { turn: call.turn }
      const answering = (result: unknown): Intent<never> => call.context.intent("answer", (at) =>
        toolReturned({ callId: call.callId, result, ...stamp, at }), (call.turn === undefined ? {} : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } }))
      return serve(call, log, answering) ?? [answering({ error: unknownToolError(call.name, toolsFor(log, call)) })]
    })
  }
}

// cancelTools settles every open tool call owned by the cancelled message invocation.
const toolCancellationTransitions = (
  calls: ReadonlyArray<PendingCall>,
  cancellation: InvocationCancellation
): ReadonlyArray<Transition<never>> => calls.map((call) => call.context.intent("answer", (at) =>
  toolReturned({
    callId: call.callId,
    result: { error: cancellation.reason === undefined ? "cancelled" : `cancelled: ${cancellation.reason}` },
    turn: cancellation.invocation.id,
    at
  }), { invocation: null }))

const cancelTools = (
  history: ReadonlyArray<Event>,
  cancellation: InvocationCancellation
): ReadonlyArray<Transition<never>> => {
  const log = positioned(history)
  if (cancellation.invocation.method !== "message") return []
  const answered = new Set(
    log.filter((event) => event.type === "ToolReturned")
      .map(toolResultPosition)
  )
  const calls = log.flatMap((event) =>
    event.type === "ToolCalled" &&
      String((event as { readonly turn?: unknown }).turn) === cancellation.invocation.id &&
      eventEpochOf(event) === cancellation.invocation.epoch &&
      !answered.has(toolCallPosition(event))
      ? [{ position: toolCallPosition(event), context: contextFor(event), callId: String(event.callId), name: String(event.name), arguments: event.arguments }]
      : []
  )
  return toolCancellationTransitions(calls, cancellation)
}

// toolsComponentFrom exposes tool dispatch and open-call cancellation through one component.
export const toolsComponentFrom = <V, R = never>(
  empty: V,
  serve: Serve<R>,
  toolsFor: (log: ReadonlyArray<Event>, call: PendingCall) => ReadonlyArray<{ readonly name: string; readonly concurrency?: ToolConcurrency }>,
  concurrency: ToolConcurrency = DEFAULT_TOOL_CONCURRENCY
): Component<V, R> => {
  const dispatch = toolsReactorFrom(serve, toolsFor, concurrency)
  return defineComponent({
    name: "agent.tools",
    state: { version: "1", schema: Schema.toCodecJson(Schema.Chunk(RecordedEvent)) },
    initial: () => Chunk.empty<Event>(),
    step: (state, event) => Chunk.append(state, event),
    output: state => {
      const log = Chunk.toReadonlyArray(state)
      return { view: empty, transitions: dispatch(log), interactions: { cancel: (cancellation: InvocationCancellation) => cancelTools(log, cancellation) } }
    }
  })
}

interface ProjectedTool<R = never> {
  readonly concurrency?: ToolConcurrency
  readonly spec: { readonly name: string }
  readonly serve?: Serve<R>
}

type OfferedTool = Omit<ProjectedTool, "serve">

type CallRecord = Omit<PendingCall, "context"> & { readonly event: Event }
const callWithContext = ({ event, ...call }: CallRecord, context: ComponentOutputContext): PendingCall => ({
  ...call, context: context.transition(eventAt(event, call.position))
})

interface PendingRecord {
  readonly call: CallRecord
  readonly offered: ReadonlyArray<OfferedTool>
  readonly log: Chunk.Chunk<Event>
}

// toolDispatchMatches associates code work with its ToolCalled occurrence (../../runtime/turn.test.ts).
export const toolDispatchMatches = (event: Event, call: Pick<PendingCall, "position">): boolean =>
  event.type === "CodeDispatched" && toolResultPosition(event) === call.position

// ToolCallView exposes request data and its committed occurrence (machine.test.ts).
export interface ToolCallView {
  readonly position: number
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly turn?: string
  readonly epoch?: number
}

export type ToolComponent<R = never> = AgentComponent<R, AgentView & ToolState, unknown>

const TOOL_SOURCE: unique symbol = Symbol("toolSource")

// toolCallOf reads the public request data attached by a tool to its proposal (machine.test.ts).
export const toolCallOf = (transition: Transition<never, unknown>): ToolCallView | undefined =>
  (transition as Transition<never, unknown> & { readonly [TOOL_SOURCE]?: ToolCallView })[TOOL_SOURCE]

const callObservation = (call: ToolCallView): ToolCallView => ({
  position: call.position,
  callId: call.callId,
  name: call.name,
  arguments: call.arguments,
  ...(call.turn === undefined ? {} : { turn: call.turn }),
  ...(call.epoch === undefined ? {} : { epoch: call.epoch })
})

// ToolState exposes retained calls and pending requests as domain data (machine.test.ts).
export interface ToolState {
  readonly calls: ReadonlyArray<ToolCallView>
  readonly pendingCalls: ReadonlyArray<ToolCallView>
}

interface IncrementalToolsState {
  readonly turns: TurnProjectionState
  readonly known: HashMap.HashMap<number, CallRecord>
  readonly pending: HashMap.HashMap<number, PendingRecord>
  readonly offers: HashMap.HashMap<string, ReadonlyArray<OfferedTool>>
  readonly heads: HashMap.HashMap<string, Event>
  readonly thread?: Event
}

const CallRecord = Schema.Struct({
  callId: Schema.String,
  position: Schema.Int,
  validationError: Schema.optionalKey(Schema.String),
  name: Schema.String,
  arguments: Schema.UndefinedOr(Schema.Unknown),
  turn: Schema.optionalKey(Schema.String),
  epoch: Schema.optionalKey(Schema.Int),
  event: RecordedEvent
})
const OfferedTool = Schema.Struct({
  spec: Schema.Struct({ name: Schema.String }),
  concurrency: Schema.optionalKey(Schema.Union([Schema.Int, Schema.Literal("unbounded")]))
})
const IncrementalToolsState = Schema.Struct({
  turns: TurnProjectionState,
  known: Schema.HashMap(Schema.Int, CallRecord),
  pending: Schema.HashMap(Schema.Int, Schema.Struct({ call: CallRecord, offered: Schema.Array(OfferedTool), log: Schema.Chunk(RecordedEvent) })),
  offers: Schema.HashMap(Schema.String, Schema.Array(OfferedTool)),
  heads: Schema.HashMap(Schema.String, RecordedEvent),
  thread: Schema.optionalKey(RecordedEvent)
})

type ToolOwnership = { readonly name: string }

// routeTools tracks offered calls and forwards child work through the inference boundary (runtime/batches.test.ts).
export const routeTools = <V, R, I>(
  child: Component<V, R, never, I>,
  toolsOf: (view: V) => ReadonlyArray<ProjectedTool<R>>,
  concurrency: ToolConcurrency = DEFAULT_TOOL_CONCURRENCY
): Component<V & ToolState, R, unknown, I> => toolsMachineFrom(child, bound => toolsOf(bound.output().view), concurrency, undefined, (view, tools) => ({ ...view, ...tools }))

const toolsMachineFrom = <V, R, O, I>(
  child: Component<V, R, never, I>,
  toolsOf: (child: ChildOf<Component<V, R, never, I>>) => ReadonlyArray<ProjectedTool<R>>,
  concurrency: ToolConcurrency,
  ownership: ToolOwnership | undefined,
  project: (view: V, tools: ToolState) => O,
  offeredOf = toolsOf
): Component<O, R, unknown, I> => {
  const limit = toolConcurrencyOf(concurrency)
  const name = ownership?.name ?? "agent.tools"
  const observation = (state: IncrementalToolsState, context: ComponentOutputContext): ToolState => {
    const trajectory = turnViewFrom(state.turns)
    const calls = trajectory.flatMap((event) => {
      if (event.type !== "ToolCalled") return []
      const call = Option.getOrUndefined(HashMap.get(state.known, toolCallPosition(event)))
      if (call === undefined) return []
      return [callObservation(call)]
    })
    return {
      calls,
      pendingCalls: (ownership === undefined
        ? admitted([...HashMap.values(state.pending)].sort((a, b) => a.call.position - b.call.position), limit, (record) => record.call, (record) => record.offered.find((tool) => tool.spec.name === record.call.name)?.concurrency)
        : [...HashMap.values(state.pending)].sort((a, b) => a.call.position - b.call.position))
        .filter((record) => {
          if (!record.offered.some(tool => tool.spec.name === record.call.name)) return false
          if (ownership === undefined) return true
          const call = callWithContext(record.call, context)
          return !Chunk.toReadonlyArray(record.log).some(event => call.context.matches("dispatch", event) || toolDispatchMatches(event, call))
        })
        .map((record) => callObservation(record.call))
    }
  }
  const output = (state: IncrementalToolsState, child: ChildOf<Component<V, R, never, I>>, _data: readonly [], context: ComponentOutputContext): ComponentOutput<O, R, unknown, I> => {
    const pending = [...HashMap.values(state.pending)].sort((a, b) => a.call.position - b.call.position)
    const selected = ownership === undefined
      ? admitted(pending, limit, (record) => record.call, (record) => record.offered.find((tool) => tool.spec.name === record.call.name)?.concurrency)
      : pending
    const tools = observation(state, context)
    const observed = project(child.output().view, tools)
    const completable = new Set(tools.pendingCalls.map(call => call.position))
    const transitions = selected.flatMap((current) => {
      const call = callWithContext(current.call, context)
      const answering: Answer = (result) => call.context.intent("answer", (at) => toolReturned({
        callId: call.callId, result, ...(call.validationError === undefined ? {} : { isFailure: true }), ...(call.turn === undefined ? {} : { turn: call.turn }), at
      }), { invocation: call.turn === undefined ? null : { method: "message", id: call.turn, epoch: call.epoch ?? 0 } })
      const propose = (): ReadonlyArray<Transition<never, R>> => {
        const tool = current.offered.find((candidate) => candidate.spec.name === current.call.name)
        const log = Chunk.toReadonlyArray(current.log)
        if (tool === undefined) return [answering({ error: call.validationError ?? unknownToolError(call.name, current.offered.map((tool) => tool.spec)) })]
        const serve = toolsOf(child).find(candidate => candidate.spec.name === call.name)?.serve
        if (serve === undefined) {
          if (ownership === undefined) return []
          throw new Error(`Missing handler for accepted tool "${call.name}"`)
        }
        if (call.validationError !== undefined) return [answering({ error: call.validationError })]
        return serve(call, log, answering) ?? []
      }
      const identity: ToolCallView = Object.freeze(callObservation(call))
      return propose().map((transition) => {
        const proposal = annotateTransition(transition, TOOL_SOURCE, identity)
        return completable.has(identity.position) && call.validationError === undefined ? withResponse(proposal, answering) : proposal
      })
    })
    const children = child.output()
    const interactions = {
      ...children.interactions!,
      cancel: (cancellation: InvocationCancellation) => {
        if (cancellation.invocation.method !== "message") return []
        const calls = [...HashMap.values(state.pending)]
          .filter((record) =>
            record.call.turn === cancellation.invocation.id &&
            (record.call.epoch ?? 0) === cancellation.invocation.epoch
          )
          .map((record) => callWithContext(record.call, context))
        return [...(child.output().interactions?.cancel?.(cancellation) ?? []), ...toolCancellationTransitions(calls, cancellation)]
      }
    }
    if (ownership === undefined) return {
      view: observed,
      interactions,
      transitions: [...transitions, ...children.transitions.filter((transition) => {
        const call = toolCallOf(transition)
        return call === undefined || completable.has(call.position)
      }).map(executionOnly)]
    }
    return { view: observed, interactions: { cancel: interactions.cancel } as I & typeof interactions, transitions: [...transitions, ...children.transitions.map(executionOnly)] }
  }
  return defineComponent<IncrementalToolsState, O, R, unknown, typeof child, readonly [], I>({
    children: child,
    name,
    state: { version: "1", schema: Schema.toCodecJson(IncrementalToolsState) },
    initial: (): IncrementalToolsState => ({
      turns: initialTurnProjection(),
      known: HashMap.empty(),
      pending: HashMap.empty(),
      offers: HashMap.empty(),
      heads: HashMap.empty()
    }),
    step: (state, event, _context, _child, previous) => {
      const eventTurn = String((event as { readonly turn?: unknown }).turn ?? "")
      let before: ReadonlyArray<OfferedTool> | undefined
      const offeredBefore = (): ReadonlyArray<OfferedTool> => {
        before ??= offeredOf(previous).map(({ spec, concurrency }) => ({
          spec: { name: spec.name }, ...(concurrency === undefined ? {} : { concurrency })
        }))
        return before
      }
      const offers = event.type === "ModelCalled" && eventTurn !== ""
        ? HashMap.set(state.offers, eventTurn, offeredBefore())
        : state.offers
      const heads = event.type === "MessageReceived"
        ? HashMap.set(state.heads, String((event as { readonly id?: unknown }).id ?? ""), event)
        : state.heads
      const thread = event.type === "ThreadCreated" ? event : state.thread
      let pending: HashMap.HashMap<number, PendingRecord> = HashMap.map(
        state.pending,
        (record): PendingRecord => ({ ...record, log: Chunk.append(record.log, event) })
      )
      let known = state.known
      if (event.type === "ToolCalled") {
        const callId = str((event as { readonly callId?: unknown }).callId)
        if (!HashMap.has(pending, toolCallPosition(event))) {
          const currentTurn = turnViewFrom(state.turns)
          const turn = (event as { readonly turn?: unknown }).turn
          const turnId = turn === undefined ? undefined : str(turn)
          const epoch = (event as { readonly epoch?: unknown }).epoch
          const call: CallRecord = {
            callId,
            position: toolCallPosition(event),
            ...(typeof event.validationError === "string" ? { validationError: event.validationError } : {}),
            event,
            name: str((event as { readonly name?: unknown }).name),
            arguments: (event as { readonly arguments?: unknown }).arguments,
            ...(turnId === undefined ? {} : { turn: turnId }),
            ...(typeof epoch === "number"
              ? { epoch }
              : {})
          }
          const prefix = [
            ...(thread === undefined ? [] : [thread]),
            ...(turnId === undefined
              ? []
              : currentTurn.length > 0 && String((currentTurn[0] as { readonly id?: unknown }).id) === turnId
                ? currentTurn
                : Option.match(HashMap.get(heads, turnId), { onNone: () => [], onSome: (head) => [head] }))
          ]
          const callOffer = turnId === undefined
            ? offeredBefore()
            : Option.getOrElse(HashMap.get(offers, turnId), offeredBefore)
          const record: PendingRecord = {
            call,
            offered: callOffer,
            log: Chunk.fromIterable([...prefix, event])
          }
          if (ownership === undefined || callOffer.some((tool) => tool.spec.name === call.name)) {
            pending = HashMap.set(pending, toolCallPosition(event), record)
            known = HashMap.set(known, toolCallPosition(event), call)
          }
        }
      }
      if (event.type === "ToolReturned") {
        const position = toolResultPosition(event)
        if (position !== undefined) pending = HashMap.remove(pending, position)
      }
      if (event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled") {
        pending = HashMap.filter(pending, (record) =>
          record.call.turn !== eventTurn || (record.call.epoch ?? 0) !== eventEpochOf(event)
        )
      }
      return {
        turns: reduceTurnProjection(state.turns, event),
        known,
        pending,
        offers,
        heads,
        ...(thread === undefined ? {} : { thread })
      }
    },
    output
  })
}

// toolComponent records visible offers as data and resolves accepted calls through current owner handlers (machine.test.ts).
export function toolComponent<R, V extends AgentView>(child: AgentComponent<R, V, never, ToolInteractions<R>>): AgentComponent<R, V & ToolState, unknown>
export function toolComponent<R, V extends AgentView, P extends AgentView>(child: AgentComponent<R, V, never, ToolInteractions<R>>, options: { readonly view: (child: V, tools: ToolState) => P }): AgentComponent<R, P, unknown>
export function toolComponent<R, V extends AgentView, P extends AgentView>(child: AgentComponent<R, V, never, ToolInteractions<R>>, options?: { readonly view: (child: V, tools: ToolState) => P }): AgentComponent<R, P | (V & ToolState), unknown> {
  const owned = toolsMachineFrom(
    child,
    bound => bound.output().interactions?.tools() ?? [],
    DEFAULT_TOOL_CONCURRENCY,
    { name: `${child.name}.dispatch` },
    (view, tools) => options === undefined ? { ...view, ...tools } : options.view(view, tools),
    bound => {
      const output = bound.output()
      const handlers = output.interactions?.tools() ?? []
      return output.view.tools.filter(tool => handlers.some(handler => handler.spec.name === tool.spec.name && handler.serve !== undefined))
    }
  )
  return { ...owned, name: child.name }
}
