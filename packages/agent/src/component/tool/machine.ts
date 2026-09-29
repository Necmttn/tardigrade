import { TurnLifecycleSchema, initialTurnLifecycle, reduceTurnLifecycle, currentTurnFrom, type TurnLifecycleState } from "@clavia/tardigrade-code/execution/turn-lifecycle"
import { ToolCommand, type ToolImplementation } from "./command"
import { pureData } from "@clavia/tardigrade-core/transition/data"
import { checkpointComposition } from "../checkpoint"
import type { ToolInteractions } from "../view"
import { type AgentComponent, type AgentView } from "../view"
import { eventIntent, annotateTransition, bindTransitionContext, executionOnly, type TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { eventAt, eventPositionOf, PositionedEvent } from "@clavia/tardigrade-core/event"
import { type Transition, type Intent } from "@clavia/tardigrade-core/runtime"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { toolCallPosition, toolResultPosition } from "../../log/tool"
import { toolReturned } from "../../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnTerminalOf } from "@clavia/tardigrade-code/execution/turns"
import { eventEpochOf } from "@clavia/tardigrade-code/execution/turns"
import type { InvocationCancellation } from "@clavia/tardigrade-core/interaction/events"
import type { Component } from "@clavia/tardigrade-core/actor"
import { component as defineComponent, withResponse, type ChildOf, type ChildSnapshot, type ComponentOutputContext, legacyComponent, type ComponentOutput } from "@clavia/tardigrade-core/actor"
import { Chunk, HashMap, Option, Schema } from "effect"
import {
  TurnProjectionSchema,
  initialTurnProjection,
  reduceTurnProjection,
  turnViewFrom,
  type TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"

// ToolConcurrency limits admitted calls while the remaining calls stay pending (../../runtime/batches.test.ts).
// ToolHistory selects the evidence supplied to tool handlers (checkpoint.properties.test.ts).
export type ToolHistory = "turn" | "call"
export const DEFAULT_TOOL_HISTORY: ToolHistory = "turn"

// toolHistoryOf rejects unsupported evidence modes at construction (machine.test.ts).
export const toolHistoryOf = (history: ToolHistory = DEFAULT_TOOL_HISTORY): ToolHistory => {
  if (history !== "turn" && history !== "call") throw new Error("tool history must be turn or call")
  return history
}

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
  return legacyComponent({
    name: "agent.tools",
    derive: (log) => ({ view: empty, transitions: dispatch(log), interactions: { cancel: cancellation => cancelTools(log, cancellation) } })
  })
}

interface ProjectedTool<R = never> {
  readonly concurrency?: ToolConcurrency
  readonly spec: { readonly name: string }
  readonly command?: ToolCommand
  readonly serve?: Serve<R>
}

interface StoredCall extends Omit<PendingCall, "context"> {
  readonly origin: Event
}

type OfferedTools =
  | { readonly kind: "routing"; readonly tools: ReadonlyArray<Omit<ProjectedTool, "serve">> }
  | { readonly kind: "child"; readonly snapshot: ChildSnapshot }

interface PendingRecord {
  readonly call: StoredCall
  readonly offered: OfferedTools
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
  readonly historyMode: ToolHistory
  readonly lifecycle: TurnLifecycleState
  readonly history?: TurnProjectionState
  readonly known: HashMap.HashMap<number, StoredCall>
  readonly pending: HashMap.HashMap<number, PendingRecord>
  readonly offers: HashMap.HashMap<string, OfferedTools>
  readonly heads: HashMap.HashMap<string, Event>
  readonly thread?: Event
}

type ToolOwnership = { readonly name: string }

// routeTools tracks offered calls and forwards child work through the inference boundary (runtime/batches.test.ts).
export const routeTools = <V, R, I>(
  child: Component<V, R, never, I>,
  toolsOf: (view: V) => ReadonlyArray<ProjectedTool<R>>,
  concurrency: ToolConcurrency = DEFAULT_TOOL_CONCURRENCY,
  checkpoint?: { readonly version: string },
  history: ToolHistory = DEFAULT_TOOL_HISTORY
): Component<V & ToolState, R, unknown, I> => toolsMachineFrom(child, bound => toolsOf(bound.output().view), concurrency, undefined, (view, tools) => ({ ...view, ...tools }), checkpoint, [], toolHistoryOf(history) === "turn")

const toolsMachineFrom = <V, R, O, I>(
  child: Component<V, R, never, I>,
  toolsOf: (child: ChildOf<Component<V, R, never, I>>) => ReadonlyArray<ProjectedTool<R>>,
  concurrency: ToolConcurrency,
  ownership: ToolOwnership | undefined,
  project: (view: V, tools: ToolState) => O,
  checkpoint?: { readonly version: string },
  implementations: ReadonlyArray<ToolImplementation<R>> = [],
  retainTurnHistory = implementations.length === 0
): Component<O, R, unknown, I> => {
  const registry = new Map<string, ToolImplementation<R>>()
  const commandKey = (name: string, version: string) => JSON.stringify([name, version])
  for (const implementation of implementations) {
    const key = commandKey(implementation.name, implementation.version)
    if (registry.has(key)) throw new Error("Duplicate tool implementation version")
    registry.set(key, implementation)
  }
  const resolve = (command: ToolCommand) => {
    const implementation = registry.get(commandKey(command.implementation, command.version))
    if (implementation === undefined) throw new Error(`Missing tool implementation: ${command.implementation}@${command.version}`)
    implementation.validate(command.input)
    return implementation
  }
  const limit = toolConcurrencyOf(concurrency)
  const name = ownership?.name ?? "agent.tools"
  const callOf = (call: StoredCall, context: ComponentOutputContext): PendingCall => {
    const { origin, ...facts } = call
    return { ...facts, context: context.transition(eventAt(origin, call.position)) }
  }
  const retainOffers = (child: ChildOf<Component<V, R, never, I>>): OfferedTools => {
    const tools = toolsOf(child)
    for (const tool of tools) {
      if (!retainTurnHistory && tool.serve !== undefined) throw new Error("Call-history routing requires durable tool commands")
      if (tool.command !== undefined) {
        if (tool.serve !== undefined) throw new Error("Tool offer declares both command and handler")
        resolve(tool.command)
      }
    }
    return tools.every(tool => tool.serve === undefined)
      ? { kind: "routing", tools: tools.map(({ spec, concurrency, command }) => ({ spec: { name: spec.name }, ...(concurrency === undefined ? {} : { concurrency }), ...(command === undefined ? {} : { command: pureData(command) as ToolCommand }) })) }
      : { kind: "child", snapshot: child.retain() }
  }
  const offersOf = (offered: OfferedTools, child: ChildOf<Component<V, R, never, I>>): ReadonlyArray<ProjectedTool<R>> =>
    offered.kind === "routing" ? offered.tools : toolsOf(child.at(offered.snapshot))
  const observation = (state: IncrementalToolsState, selected: ReadonlyArray<PendingRecord>, child: ChildOf<Component<V, R, never, I>>, context: ComponentOutputContext): ToolState => {
    const current = currentTurnFrom(state.lifecycle)
    const calls = current === undefined ? [] : [...HashMap.values(state.known)]
      .filter(call => call.turn === current.id)
      .sort((a, b) => a.position - b.position)
      .map(callObservation)
    return {
      calls,
      pendingCalls: selected
        .filter((record) => offersOf(record.offered, child).some((tool) => tool.spec.name === record.call.name) && (ownership === undefined || !Chunk.toReadonlyArray(record.log).some((event) => (callOf(record.call, context).context.matches("dispatch", event) || toolDispatchMatches(event, record.call)))))
        .map((record) => callObservation(record.call))
    }
  }
  const output = (state: IncrementalToolsState, child: ChildOf<Component<V, R, never, I>>, _data: readonly [], context: ComponentOutputContext): ComponentOutput<O, R, unknown, I> => {
    const pending = [...HashMap.values(state.pending)].sort((a, b) => a.call.position - b.call.position)
    const selected = ownership === undefined
      ? admitted(pending, limit, (record) => record.call, (record) => offersOf(record.offered, child).find((tool) => tool.spec.name === record.call.name)?.concurrency)
      : pending
    const tools = observation(state, selected, child, context)
    const observed = project(child.output().view, tools)
    const completable = new Set(tools.pendingCalls.map(call => call.position))
    const transitions = selected.flatMap((current) => {
      const call = callOf(current.call, context)
      const answering: Answer = (result) => eventIntent(call.context, "answer", [{
        type: "ToolReturned", callId: call.callId, result, ...(call.validationError === undefined ? {} : { isFailure: true }), ...(call.turn === undefined ? {} : { turn: call.turn })
      }], { invocation: call.turn === undefined ? null : { method: "message", id: call.turn, epoch: call.epoch ?? 0 } })
      const propose = (): ReadonlyArray<Transition<never, R>> => {
        const tool = offersOf(current.offered, child).find((candidate) => candidate.spec.name === current.call.name)
        const log = Chunk.toReadonlyArray(current.log)
        if (tool === undefined) return [answering({ error: call.validationError ?? unknownToolError(call.name, offersOf(current.offered, child).map((tool) => tool.spec)) })]
        if (tool.serve === undefined && tool.command === undefined) return []
        if (call.validationError !== undefined) return [answering({ error: call.validationError })]
        return (tool.command === undefined ? tool.serve!(call, log, answering) : resolve(tool.command).serve(tool.command.input, call, log, answering)) ?? []
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
          .map((record) => callOf(record.call, context))
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
    ...(checkpoint === undefined ? {} : { checkpoint: (bound: ChildOf<Component<V, R, never, I>>) => {
      const snapshot = bound.snapshotSchema
      if (snapshot === undefined) throw new Error("Tool checkpoints require child checkpoint support")
      const offered = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("child"), snapshot }),
        Schema.Struct({ kind: Schema.Literal("routing"), tools: Schema.Array(Schema.Struct({
          command: Schema.optionalKey(ToolCommand.check(Schema.makeFilter(command => {
            try { resolve(command); return true } catch { return false }
          }, { title: "compatible tool command" }))),
          spec: Schema.Struct({ name: Schema.String }), concurrency: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.Literal("unbounded")]))
        })) })
      ])
      const call = Schema.Struct({
        origin: PositionedEvent, callId: Schema.String, position: Schema.Finite,
        validationError: Schema.optionalKey(Schema.String), name: Schema.String, arguments: Schema.Unknown,
        turn: Schema.optionalKey(Schema.String), epoch: Schema.optionalKey(Schema.Finite)
      })
      return { version: checkpoint.version, schema: Schema.toCodecJson(Schema.Struct({
        historyMode: Schema.Literal(retainTurnHistory ? "turn" : "call"),
        lifecycle: TurnLifecycleSchema, history: Schema.optionalKey(TurnProjectionSchema),
        known: Schema.HashMap(Schema.Finite, call),
        pending: Schema.HashMap(Schema.Finite, Schema.Struct({ call, offered, log: Schema.Chunk(PositionedEvent) })),
        offers: Schema.HashMap(Schema.String, offered), heads: Schema.HashMap(Schema.String, PositionedEvent),
        thread: Schema.optionalKey(PositionedEvent)
      })) }
    } }),
    initial: (): IncrementalToolsState => ({
      historyMode: retainTurnHistory ? "turn" : "call",
      lifecycle: initialTurnLifecycle(),
      ...(retainTurnHistory ? { history: initialTurnProjection() } : {}),
      known: HashMap.empty(),
      pending: HashMap.empty(),
      offers: HashMap.empty(),
      heads: HashMap.empty()
    }),
    step: (state, event, _context, _child, previous) => {
      const eventTurn = String((event as { readonly turn?: unknown }).turn ?? "")
      const offers = event.type === "ModelCalled" && eventTurn !== ""
        ? HashMap.set(state.offers, eventTurn, retainOffers(previous))
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
          const current = currentTurnFrom(state.lifecycle)
          const currentTurn = state.history === undefined ? (current === undefined ? [] : [current.head.event]) : turnViewFrom(state.history)
          const turn = (event as { readonly turn?: unknown }).turn
          const turnId = turn === undefined ? undefined : str(turn)
          const epoch = (event as { readonly epoch?: unknown }).epoch
          const call: StoredCall = {
            callId,
            position: toolCallPosition(event),
            ...(typeof event.validationError === "string" ? { validationError: event.validationError } : {}),
            origin: event,
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
            ? retainOffers(previous)
            : Option.getOrElse(HashMap.get(offers, turnId), () => retainOffers(previous))
          const record: PendingRecord = {
            call,
            offered: callOffer,
            log: Chunk.fromIterable([...prefix, event])
          }
          if (ownership === undefined || offersOf(callOffer, previous).some((tool) => tool.spec.name === call.name && (tool.serve !== undefined || tool.command !== undefined))) {
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
        historyMode: state.historyMode,
        lifecycle: reduceTurnLifecycle(state.lifecycle, event),
        ...(state.history === undefined ? {} : { history: reduceTurnProjection(state.history, event) }),
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

// toolComponent keeps offered handlers private and exposes their work through output transitions (machine.test.ts).
export function toolComponent<R, V extends AgentView>(child: AgentComponent<R, V, never, ToolInteractions<R>>, options?: { readonly history?: ToolHistory; readonly implementations?: ReadonlyArray<ToolImplementation<R>>; readonly checkpoint?: { readonly version: string } }): AgentComponent<R, V & ToolState, unknown>
export function toolComponent<R, V extends AgentView, P extends AgentView>(child: AgentComponent<R, V, never, ToolInteractions<R>>, options: { readonly history?: ToolHistory; readonly implementations?: ReadonlyArray<ToolImplementation<R>>; readonly checkpoint?: { readonly version: string }; readonly view: (child: V, tools: ToolState) => P }): AgentComponent<R, P, unknown>
export function toolComponent<R, V extends AgentView, P extends AgentView>(child: AgentComponent<R, V, never, ToolInteractions<R>>, options?: { readonly history?: ToolHistory; readonly implementations?: ReadonlyArray<ToolImplementation<R>>; readonly checkpoint?: { readonly version: string }; readonly view?: (child: V, tools: ToolState) => P }): AgentComponent<R, P | (V & ToolState), unknown> {
  const owned = toolsMachineFrom(
    child,
    bound => bound.output().interactions?.tools() ?? [],
    DEFAULT_TOOL_CONCURRENCY,
    { name: `${child.name}.dispatch` },
    (view, tools) => options?.view === undefined ? { ...view, ...tools } : options.view(view, tools),
    options?.checkpoint ?? checkpointComposition([child]).checkpoint,
    options?.implementations,
    options?.history === undefined ? undefined : options.history === "turn"
  )
  return { ...owned, name: child.name }
}
