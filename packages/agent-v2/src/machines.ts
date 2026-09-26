import { boundedInputs, DEFAULT_MAX_INPUT_CHARS } from "./context"
import { Effect, Schema } from "effect"
import { defineMachine, defineInterface, input, output, type MachineEffect, type Projection, type Token } from "@clavia/tardigrade-core-v2"
import { AgentEvent, PermissionDecisionInput, Decision, ModelReply, ToolCall, ToolSpec } from "./events"
import { Model, PermissionChecker, Summarizer, ToolExecutor } from "./services"
import { component } from "./component"
import * as ports from "./ports"
import * as projections from "./projections"

export function system(options: { readonly prompt: string }) {
  return component({
    name: "system", schema: Schema.String, initial: options.prompt, state: () => options.prompt,
    outputs: [output(ports.SystemPrompt, (view: { value: string }) => ({ value: view.value }), { broadcast: true })],
  })
}

export function trajectory(options: { readonly state: Projection<AgentEvent, typeof ports.Conversation.Type> }) {
  return component({
    name: "trajectory", schema: ports.Conversation, initial: { revision: 0, events: [] }, state: options.state,
    outputs: [output(ports.Trajectory, (view: { value: typeof ports.Conversation.Type }) => ({ value: view.value }), { broadcast: true })],
  })
}

export const CompactState = Schema.Struct({ history: ports.Conversation, source: ports.Conversation })
export const compactState = (events: readonly AgentEvent[]): typeof CompactState.Type => ({
  history: { events, revision: events.length }, source: { events: [], revision: -1 },
})
export function compact(options: { readonly maxEvents: number; readonly maxInputChars?: number; readonly state: Projection<AgentEvent, typeof CompactState.Type> }) {
  if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1) throw new Error("maxEvents must be a positive integer")
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  boundedInputs([], maxInputChars)
  const context = (state: typeof CompactState.Type): typeof ports.ContextView.Type => {
    const { events, revision } = state.source
    const cut = Math.max(0, events.length - options.maxEvents)
    // Whole turns preserve model-call and tool-result relationships.
    const boundary = events.findIndex((event, index) => index >= cut && event.type === "MessageReceived")
    const covered = cut === 0 ? 0 : boundary > 0 ? boundary : -1
    const request = events.findLast(event => event.type === "SummaryRequested" && event.covered === covered)
    const result = request?.type === "SummaryRequested" && events.findLast(event => event.type === "SummaryReturned" && event.callId === request.callId)
    const bounded = boundedInputs(covered < 0 ? [] : events.slice(covered), maxInputChars)
    const summary = result && result.type === "SummaryReturned" ? result.summary : ""
    if (summary.length > maxInputChars) bounded.clipped.push({ eventIndex: -1, field: "summary", originalChars: summary.length, maxInputChars })
    return {
      revision, ready: revision === state.history.revision && covered >= 0 && (covered === 0 || Boolean(result)),
      ...bounded, maxInputChars, summary: summary.slice(0, maxInputChars),
    }
  }
  return component({
    name: "compact", schema: CompactState, initial: compactState([]), state: options.state,
    inputs: [input(ports.Trajectory, (state: typeof CompactState.Type, source) => ({ type: "Update" as const, value: { ...state, source } }))],
    outputs: [output(ports.BoundedContext, (view: { value: typeof CompactState.Type }) => ({ value: context(view.value) }), { broadcast: true })],
    effects: state => {
      const events = state.source.events
      if (state.source.revision !== state.history.revision || context(state).ready) return []
      const cut = Math.max(0, events.length - options.maxEvents)
      const covered = events.findIndex((event, index) => index >= cut && event.type === "MessageReceived")
      if (covered <= 0 || events.some(event => event.type === "SummaryRequested" && event.covered === covered)) return []
      const callId = `summary:${covered}`
      return [{
        request: { type: "SummaryRequested", callId, covered },
        run: Effect.gen(function* () {
          const summarizer = yield* Summarizer
          return { type: "SummaryReturned" as const, callId, summary: yield* summarizer.summarize(boundedInputs(events.slice(0, covered), maxInputChars)) }
        }),
      }]
    },
  })
}

export const PermissionState = Schema.Struct({
  revision: Schema.Number, requests: Schema.Array(ToolCall),
  decisions: Schema.Record(Schema.String, Decision), requested: Schema.Array(Schema.String),
})
export const permissionState = (events: readonly AgentEvent[]): typeof PermissionState.Type => ({
  revision: events.length, requests: projections.pendingTools(events), decisions: projections.toolDecisions(events),
  requested: events.filter(event => event.type === "PermissionRequested").map(event => event.callId),
})
export function permissions(options: {
  readonly state: Projection<AgentEvent, typeof PermissionState.Type>
  readonly mode?: "automatic" | "manual"
}) {
  const State = Schema.Struct({ ...PermissionState.fields, queued: Schema.Array(PermissionDecisionInput) })
  type State = typeof State.Type
  const Refresh = Schema.Struct({ type: Schema.Literal("Refresh"), source: ports.Conversation })
  const Resolve = Schema.Struct({ type: Schema.Literal("Resolve"), ...PermissionDecisionInput.fields })
  const pending = (state: State) => state.requests.filter(call => state.requested.includes(call.callId) && !Object.hasOwn(state.decisions, call.callId))
  const outputs = [output(ports.ToolPermission, (view: { value: State }) => ({
    value: { revision: view.value.revision, decisions: view.value.decisions },
  }), { broadcast: true })]
  const contract = defineInterface({
    ready: { view: Schema.Struct({ value: State, mode: Schema.Literals(["automatic", "manual"]) }), interactions: { Refresh }, outputs },
    awaitingPermission: { view: Schema.Struct({ value: State, mode: Schema.Literals(["automatic", "manual"]) }), interactions: { Refresh, Resolve }, outputs },
  })
  const refresh = (state: State, source: typeof ports.Conversation.Type): State => {
    const projected = options.state(source.events)
    return { ...projected, queued: state.queued.filter(item => !Object.hasOwn(projected.decisions, item.callId)) }
  }
  const machine = defineMachine({
    name: "permissions",
    interface: contract,
    initial: { ...options.state([]), queued: [] } as State,
    view: state => ({ position: pending(state).length ? "awaitingPermission" as const : "ready" as const, value: state, mode: options.mode ?? "automatic" }),
    inputs: [
      input(ports.Trajectory, (_state: State, source) => ({ type: "Refresh" as const, source })),
      input(ports.ResolvePermission, (_state: State, decision) => ({ type: "Resolve" as const, ...decision })),
    ],
    transitions: {
      Refresh: (state, event) => refresh(state, event.source),
      Resolve: (state, event) => {
        if (!pending(state).some(call => call.callId === event.callId) || state.queued.some(item => item.callId === event.callId)) {
          throw new Error(`Permission request is not pending: ${event.callId}`)
        }
        return { ...state, queued: [...state.queued, { callId: event.callId, decision: event.decision }] }
      },
    },
    effects: (view): readonly MachineEffect<AgentEvent, Error, PermissionChecker>[] => {
      const state = view.value
      if (state.queued.length) return state.queued.map(item => {
        const event = { type: "PermissionResolved" as const, ...item }
        return { request: event, recorded: true, run: Effect.succeed(event) }
      })
      return state.requests.filter(call => !Object.hasOwn(state.decisions, call.callId) && !state.requested.includes(call.callId)).map(call => {
        const request = { ...call, type: "PermissionRequested" as const }
        if (options.mode === "manual") return { request, recorded: true, run: Effect.succeed(request) }
        return {
          request,
          run: Effect.gen(function* () {
            const checker = yield* PermissionChecker
            return { type: "PermissionResolved" as const, callId: call.callId, decision: yield* checker.check(call) }
          }),
        }
      })
    },
  })
  return machine
}

export const UsageState = Schema.Struct({ used: Schema.Number, revision: Schema.Number, requests: Schema.Array(ToolCall) })
export const toolBudgetState = (events: readonly AgentEvent[]): typeof UsageState.Type =>
  ({ used: projections.toolUsage(events), revision: events.length, requests: projections.pendingTools(events) })
export const inferBudgetState = (events: readonly AgentEvent[]): typeof UsageState.Type =>
  ({ used: projections.inferenceUsage(events), revision: events.length, requests: [] })

export function budget<const Name extends string>(options: {
  readonly name: Name
  readonly limit: number
  readonly state: Projection<AgentEvent, typeof UsageState.Type>
  readonly output: { readonly kind: "tools"; readonly port: Token<typeof ports.PermissionView.Type> } | { readonly kind: "inference"; readonly port: Token<Decision> }
}) {
  if (!Number.isFinite(options.limit) || options.limit < 0) throw new Error("Budget limit must be finite and nonnegative")
  const decision = (used: number): Decision => used < options.limit
    ? { allowed: true } : { allowed: false, reason: `${options.name} exhausted: used=${used}, limit=${options.limit}` }
  const port = options.output.kind === "tools"
    ? output(options.output.port, (view: { value: typeof UsageState.Type }) => ({
      value: { revision: view.value.revision, decisions: Object.fromEntries(view.value.requests.map((call, index) => [call.callId, decision(view.value.used + index)])) },
    }), { broadcast: true })
    : output(options.output.port, (view: { value: typeof UsageState.Type }) => ({ value: decision(view.value.used) }), { broadcast: true })
  return component({
    name: options.name, schema: UsageState, initial: { used: 0, revision: 0, requests: [] }, state: options.state, outputs: [port],
  })
}

export const ToolsState = Schema.Struct({
  revision: Schema.Number, requests: Schema.Array(ToolCall), started: Schema.Array(Schema.String),
  budget: Schema.NullOr(ports.PermissionView), permission: Schema.NullOr(ports.PermissionView),
})
export const toolsState = (events: readonly AgentEvent[]): typeof ToolsState.Type => ({
  revision: events.length, requests: projections.pendingTools(events),
  started: events.filter(event => event.type === "ToolCalled").map(event => event.callId),
  budget: null, permission: null,
})
export function tools(options: { readonly available: readonly ToolSpec[]; readonly state: Projection<AgentEvent, typeof ToolsState.Type> }) {
  if (new Set(options.available.map(tool => tool.name)).size !== options.available.length) throw new Error("Duplicate tool name")
  return component({
    name: "tools", schema: ToolsState, initial: toolsState([]), state: options.state,
    inputs: [
      input(ports.ToolBudget, (state: typeof ToolsState.Type, budget) => ({ type: "Update" as const, value: { ...state, budget } })),
      input(ports.ToolPermission, (state: typeof ToolsState.Type, permission) => ({ type: "Update" as const, value: { ...state, permission } })),
    ],
    outputs: [output(ports.AvailableTools, (_view: { value: typeof ToolsState.Type }) => ({ value: options.available }), { broadcast: true })],
    effects: state => {
      if (state.budget?.revision !== state.revision || state.permission?.revision !== state.revision) return []
      const { budget, permission } = state
      return state.requests.filter(call => !state.started.includes(call.callId)).flatMap(call => {
        const policies = [budget.decisions[call.callId], permission.decisions[call.callId]]
        if (policies.some(decision => decision === undefined)) return []
        const decision: Decision = !options.available.some(tool => tool.name === call.name)
          ? { allowed: false, reason: `Unknown tool: ${call.name}` }
          : policies.find(decision => decision && !decision.allowed) ?? { allowed: true }
        return [{
          request: { ...call, type: "ToolCalled" as const, decision },
          run: Effect.gen(function* () {
            if (!decision.allowed) return { type: "ToolReturned" as const, callId: call.callId, output: null, error: decision.reason }
            const executor = yield* ToolExecutor
            return yield* executor.execute(call).pipe(
              Effect.map(output => ({ type: "ToolReturned" as const, callId: call.callId, output, error: null })),
              Effect.catch(error => Effect.succeed({ type: "ToolReturned" as const, callId: call.callId, output: null, error: error.message })),
            )
          }),
        }]
      })
    },
  })
}

export const InferState = Schema.Struct({
  revision: Schema.Number, turnId: Schema.String, callId: Schema.String, needed: Schema.Boolean, blocked: Schema.Boolean,
  context: Schema.NullOr(ports.ContextView), permission: Schema.NullOr(Decision), system: Schema.NullOr(Schema.String), tools: Schema.NullOr(Schema.Array(ToolSpec)),
})
export const inferState = (events: readonly AgentEvent[]): typeof InferState.Type =>
  ({ ...projections.inferState(events), context: null, permission: null, system: null, tools: null })
export function infer(options: { readonly state: Projection<AgentEvent, typeof InferState.Type> }) {
  return component({
    name: "infer", schema: InferState, initial: inferState([]), state: options.state,
    inputs: [
      input(ports.BoundedContext, (state: typeof InferState.Type, context) => ({ type: "Update" as const, value: { ...state, context } })),
      input(ports.InferBudget, (state: typeof InferState.Type, permission) => ({ type: "Update" as const, value: { ...state, permission } })),
      input(ports.SystemPrompt, (state: typeof InferState.Type, system) => ({ type: "Update" as const, value: { ...state, system } })),
      input(ports.AvailableTools, (state: typeof InferState.Type, tools) => ({ type: "Update" as const, value: { ...state, tools } })),
    ],
    effects: state => {
      const { context, system, tools, permission, callId, turnId } = state
      if (!state.needed || state.blocked || !context?.ready || context.revision !== state.revision || system === null || tools === null || !permission?.allowed) return []
      return [{
        request: { type: "ModelCalled", callId, turnId },
        run: Effect.gen(function* () {
          const model = yield* Model
          const response = yield* model.call({ system, tools, events: context.events, summary: context.summary, clipped: context.clipped })
          const reply = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(ModelReply)(response),
            catch: error => new Error(String(error)),
          })
          if (!Number.isFinite(reply.cost) || reply.cost < 0) return yield* Effect.fail(new Error("Model cost must be finite and nonnegative"))
          if (new Set(reply.toolCalls.map(call => call.callId)).size !== reply.toolCalls.length) return yield* Effect.fail(new Error("Duplicate tool call id"))
          return { type: "ModelReturned" as const, callId, reply: { ...reply, toolCalls: reply.toolCalls.map((call, index) => ({ ...call, callId: `${callId}:tool:${index}` })) } }
        }),
      }]
    },
  })
}
