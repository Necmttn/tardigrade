import { checkpointFor } from "../checkpoint"
import { supportsCheckpoint, type ChildSnapshot } from "@clavia/tardigrade-core/component"
import { BudgetLedgerSchema, initialBudgetLedger, reduceBudgetLedger, budgetTurnFrom, type BudgetLedger } from "./state"
import type { InvocationRef } from "@clavia/tardigrade-core/interaction/invocation"
import type { Intent } from "@clavia/tardigrade-core/intent"
import type { ComponentResult } from "@clavia/tardigrade-core/component"
import { EventIntentRecord, eventIntentRecordOf, restoreEventIntent, bindTransitionContext, transitionKeyOf } from "@clavia/tardigrade-core/transition/transition"
import {
  component as defineComponent,
  type Component,
  type ChildOf,
  type ComponentWork,
  type ComponentReadonly,
  type ComponentRequirements,
  type ComponentView,
  type ComponentViews
} from "@clavia/tardigrade-core/actor"
import { budgetDenied, budgetExhausted, budgetGranted } from "../../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnHead } from "@clavia/tardigrade-code/execution/turns"
import { HashSet, Schema } from "effect"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentView } from "../view"
import { eventAt, eventPositionOf, PositionedEvent } from "@clavia/tardigrade-core/event"

// BudgetPolicy sets the allowance for turns that declare no budget (budget.test.ts).
export interface BudgetPolicy {
  readonly limit: number
}

interface BudgetRejection<Result> {
  readonly onExhausted: (
    reason: string,
    settle: (result: NoInfer<Result>) => Intent<never> | undefined
  ) => Intent<never> | undefined
  readonly rejectionMessage?: string
}

export interface BudgetLimit<ChildView, Result = unknown> extends Partial<BudgetRejection<Result>> {
  readonly limit: number
  readonly usage: (childView: ComponentReadonly<ChildView>) => number
}

export type BudgetOptions<ChildView, Result = unknown> = BudgetRejection<Result> & {
  readonly view?: (childView: ComponentReadonly<ChildView>, budget: BudgetState) => ChildView
} & (
  | { readonly limit?: number; readonly usage: BudgetLimit<ChildView>["usage"]; readonly limits?: never }
  | { readonly limits: ReadonlyArray<BudgetLimit<ChildView, Result>>; readonly limit?: never; readonly usage?: never }
)

// DEFAULT_BUDGET_POLICY is the default policy applied by budget and spawned agents.
export const DEFAULT_BUDGET_POLICY: BudgetPolicy = { limit: 40 }

// budgetPolicyOf applies the exported default to omitted policy fields.
export const budgetPolicyOf = (policy: Partial<BudgetPolicy> = {}): BudgetPolicy => {
  const limit = policy.limit ?? DEFAULT_BUDGET_POLICY.limit
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`budget limit must be a positive finite number, got ${JSON.stringify(limit)}`)
  }
  return { limit }
}

// initialAllowance reads the turn option before the initial grant is committed (budget.test.ts).
const initialAllowance = (events: ReadonlyArray<Event>, fallback: number): number => {
  const amount = turnHead(events)?.budget
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : fallback
}

// budgetOf uses the configured allowance until its initial grant is committed (budget.test.ts).
export const budgetOf = (view: ReadonlyArray<Event>, policy: Partial<BudgetPolicy> = {}): number => {
  const base = view.some((event) => event.type === "BudgetGranted" && event.initial === true)
    ? 0 : initialAllowance(view, budgetPolicyOf(policy).limit)
  const granted = view.reduce(
    (n, e) => (e.type === "BudgetGranted" ? n + Number((e as { amount?: unknown }).amount ?? 0) : n),
    0
  )
  return base + granted
}

// BudgetPhase names whether a turn may spend, request more budget, or must finish.
export type BudgetPhase = "spending" | "exhausted" | "denied"

// BudgetState exposes every configured limit and summarizes the first exceeded rule, or the first rule when none is exceeded (budget.properties.test.ts).
export interface BudgetState {
  readonly limit: number
  readonly used: number
  readonly remaining: number
  readonly phase: BudgetPhase
  readonly limits?: ReadonlyArray<{ readonly limit: number; readonly used: number; readonly remaining: number }>
}

// budgetPhase returns the phase established by the latest lifecycle marker
// (budget.test.ts, "budgetPhase reads the most recent marker").
export const budgetPhase = (trajectory: ReadonlyArray<Event>): BudgetPhase => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const t = trajectory[i]!.type
    if (t === "BudgetExhausted") return "exhausted"
    if (t === "BudgetDenied") return "denied"
    if (t === "BudgetGranted") return "spending"
    if (t === "MessageReceived") return "spending"
  }
  return "spending"
}

// budgetSpent reports whether the budgeted subtree is withdrawn for this turn.
export const budgetSpent = (trajectory: ReadonlyArray<Event>): boolean => budgetPhase(trajectory) !== "spending"

// DEFAULT_BUDGET_REJECTION describes a refusal independently of the governed child (budget.test.ts).
export const DEFAULT_BUDGET_REJECTION = "Budget exhausted."

type BudgetInput =
  Component<object, never> | Component<object, unknown> | ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
type BudgetView<C> =
  C extends ReadonlyArray<AgentComponent<unknown>> ? AgentView & { readonly children: ComponentViews<C> } : ComponentView<C> & object
type BudgetRequirements<C> =
  C extends ReadonlyArray<AgentComponent<unknown>> ? ComponentRequirements<C[number]> : ComponentRequirements<C>

// BudgetControl describes decisions accepted by a budget (escalation.test.ts).
export interface BudgetControl {
  readonly grant: (amount: number, request: { readonly callId: string; readonly turn: string }, at: number) => Event
  readonly deny: (reason: string, request: { readonly callId: string; readonly turn: string }, at: number) => Event
}

// BudgetComponent exposes allowance state and the decision protocol for its parent (escalation.test.ts).
export type BudgetComponent<R = never, Result = never, View = AgentView> = Component<View & BudgetState, R, Result> & { readonly budget: BudgetControl }

// budget rejects response-capable work when current usage exceeds the allowance (budget.test.ts).
export const budget = <
  const C extends BudgetInput
>(
  components: C,
  options: BudgetOptions<BudgetView<C>, NoInfer<ComponentResult<C extends ReadonlyArray<unknown> ? C[number] : C>>>
): BudgetComponent<BudgetRequirements<C>, ComponentResult<C extends ReadonlyArray<unknown> ? C[number] : C>, BudgetView<C>> => {
  type Result = ComponentResult<C extends ReadonlyArray<unknown> ? C[number] : C>
  type R = BudgetRequirements<C>
  type ChildView = BudgetView<C>
  const multiple = options.limits !== undefined
  if (multiple && (options.usage !== undefined || options.limit !== undefined)) throw new Error("budget accepts either limits or limit and usage")
  const rules: ReadonlyArray<BudgetLimit<ChildView, Result>> = options.limits ?? [{ limit: options.limit ?? DEFAULT_BUDGET_POLICY.limit, usage: options.usage! }]
  if (rules.length === 0) throw new Error("budget limits must contain at least one rule")
  const resolved = rules.map(rule => ({ ...rule, ...budgetPolicyOf(rule) }))
  const name = "budget"
  const combined = (
    Array.isArray(components)
      ? defineComponent({
          name: `${name}.children`,
          children: components as ReadonlyArray<AgentComponent<unknown>>,
          ...checkpointFor(components as ReadonlyArray<AgentComponent<unknown>>, Schema.Null),
          initial: () => null,
          step: state => state,

          output: (_state, children) => {
            const outputs = children.map(child => child.output())
            return {
              view: { ...outputs.reduce((view, output) => AGENT_VIEW_ALGEBRA.combine(view, output.view), AGENT_VIEW_ALGEBRA.empty), children: outputs.map(output => output.view) },
              transitions: outputs.flatMap(output => output.transitions),
              interactions: {
                cancel: (cancellation) => children.flatMap(child => child.output().interactions?.cancel?.(cancellation) ?? [])
              }
            }
          }
        })
      : components
  ) as unknown as Component<ChildView, R, Result>
  const measure = (childView: ComponentReadonly<ChildView>, turn: ReturnType<typeof budgetTurnFrom>): BudgetState => {
    const limits = resolved.map(rule => {
      const used = rule.usage(childView)
      if (!Number.isFinite(used) || used < 0) throw new Error("budget usage must be a finite nonnegative number")
      const limit = multiple ? rule.limit : turn.granted + (turn.initial ? 0 : initialAllowance(turn.head === undefined ? [] : [turn.head], rule.limit))
      return { limit, used, remaining: Math.max(0, limit - used) }
    })
    const exceeded = limits.find(rule => rule.used > rule.limit)
    return {
      ...(exceeded ?? limits[0]!),
      phase: multiple ? exceeded === undefined ? "spending" : "exhausted" : turn.phase,
      ...(multiple ? { limits } : {})
    }
  }
  type Child = ChildOf<typeof combined>
  const refuse = (transition: ComponentWork<R, Result>, state: BudgetState): Intent<never> | undefined => {
    if (transition.respond === undefined) return undefined
    const index = state.limits?.findIndex(rule => rule.used > rule.limit) ?? -1
    const rule = resolved[index < 0 ? 0 : index]!
    return (rule.onExhausted ?? options.onExhausted)(rule.rejectionMessage ?? options.rejectionMessage ?? DEFAULT_BUDGET_REJECTION, transition.respond)
  }
  const derived = (
    child: Child,
    facts: BudgetMachineState,
    refused: ReadonlyArray<Intent<never>>,
    admitted: HashSet.HashSet<string>
  ) => {
    const children = child.output()
    const turn = budgetTurnFrom(facts.ledger)
    const state = measure(children.view, turn)
    const { used, limit: allowance } = state
    const exhaustion = (event: Event, used: number, tag = "wall", invocation?: InvocationRef | null): Intent<never> => {
      const id = event.turn ?? turn.head?.id
      return bindTransitionContext(event, name).intent(tag, (at) => budgetExhausted({
        budget: allowance, used, at,
        ...(id === undefined ? {} : { turn: String(id) })
      }), invocation === undefined ? {} : { invocation })
    }
    const position = facts.position
    const rejected: Array<Intent<never>> = []
    const selected = children.transitions.flatMap((transition): ReadonlyArray<ComponentWork<R, Result>> => {
      const completion = refuse(transition, state)
      if (completion !== undefined && HashSet.has(facts.refusedKeys, completion.key)) return []
      if (transition.respond === undefined || HashSet.has(admitted, completion?.key ?? transition.key)) return [transition]
      if (completion !== undefined) rejected.push(completion)
      if (turn.phase !== "spending") return []
      const head = turn.head
      const invocation =
        transition.invocation ??
        (head === undefined
          ? undefined
          : { method: "message", id: String(head.id), epoch: turn.epoch })
      return [exhaustion(
        eventAt({ type: "BudgetCheck", ...(invocation === undefined ? {} : { turn: invocation.id }) }, position),
        used, `wall/${transition.key}`, invocation ?? null
      )]
    })
    const refusals = refused
    const wall = refusals.length > 0 && used > allowance && turn.phase === "spending" && facts.last !== undefined
      ? [exhaustion(facts.last, used)] : []
    const head = turn.head
    const initial =
      !multiple && head !== undefined && !turn.initial
        ? [
            bindTransitionContext(head, name).intent("budget.initial", (at) =>
              budgetGranted({
                amount: initialAllowance([head], resolved[0]!.limit),
                initial: true,
                turn: String(head.id),
                at
              })
            )
          ]
        : []
    return {
      view: { ...(options.view?.(children.view, state) ?? children.view), ...state } as ChildView & BudgetState,
      transitions: [...initial, ...wall, ...refusals, ...selected, ...rejected] as ReadonlyArray<ComponentWork<R, Result>>
    }
  }

  type BudgetMachineState = {
    readonly ledger: BudgetLedger
    readonly position: number
    readonly last?: Event
    readonly recorded: HashSet.HashSet<string>
    readonly refusedKeys: HashSet.HashSet<string>
    readonly refused: ReadonlyArray<
      | { readonly kind: "events"; readonly key: string; readonly response: EventIntentRecord }
      | { readonly kind: "child"; readonly snapshot: ChildSnapshot; readonly work: string; readonly key: string; readonly measured: BudgetState }
    >
    // admitted preserves work accepted before later requests cross the limit (runtime/batches.test.ts).
    readonly admitted: HashSet.HashSet<string>
  }
  const classify = (state: BudgetMachineState, child: Child): BudgetMachineState => {
    const refused = [...state.refused]
    let admitted = state.admitted
    let refusedKeys = state.refusedKeys
    const output = child.output()
    const measured = measure(output.view, budgetTurnFrom(state.ledger))
    const affordable = measured.used <= measured.limit
    for (const transition of output.transitions) {
      if (transition.respond === undefined) continue
      const completion = refuse(transition, measured)
      const key = completion?.key ?? transition.key
      if (HashSet.has(admitted, key) || HashSet.has(refusedKeys, key)) continue
      if (affordable) admitted = HashSet.add(admitted, key)
      else if (completion !== undefined) {
        refusedKeys = HashSet.add(refusedKeys, key)
        if (HashSet.has(state.recorded, key)) continue
        const response = eventIntentRecordOf(completion)
        refused.push(response === undefined
          ? { kind: "child", snapshot: child.retain(), work: transition.key, key, measured }
          : { kind: "events", key, response })
      }
    }
    return { ...state, refused, admitted, refusedKeys }
  }
  const component = defineComponent<BudgetMachineState, ChildView & BudgetState, R, Result, typeof combined>({
    children: combined,
    name,
    ...(supportsCheckpoint(combined) ? { checkpoint: (child: Child) => ({ version: "3", schema: Schema.toCodecJson(Schema.Struct({
      ledger: BudgetLedgerSchema, position: Schema.Finite, last: Schema.optionalKey(PositionedEvent),
      recorded: Schema.HashSet(Schema.String), refusedKeys: Schema.HashSet(Schema.String), admitted: Schema.HashSet(Schema.String),
      refused: Schema.Array(Schema.Union([Schema.Struct({ kind: Schema.Literal("events"), key: Schema.String, response: EventIntentRecord }), Schema.Struct({
        kind: Schema.Literal("child"), snapshot: child.snapshotSchema!, work: Schema.String, key: Schema.String,
        measured: Schema.Struct({ limit: Schema.Finite, used: Schema.Finite, remaining: Schema.Finite,
          phase: Schema.Literals(["spending", "exhausted", "denied"]),
          limits: Schema.optionalKey(Schema.Array(Schema.Struct({ limit: Schema.Finite, used: Schema.Finite, remaining: Schema.Finite }))) })
      })]))
    })) }) } : {}),
    initial: child => classify({
      ledger: initialBudgetLedger(), position: 0, recorded: HashSet.empty<string>(), refusedKeys: HashSet.empty<string>(),
      refused: [],
      admitted: HashSet.empty<string>()
    }, child),
    step: (state, event, _context, child) => {
      const key = transitionKeyOf(event)
      return classify({
        ...state,
        ledger: reduceBudgetLedger(state.ledger, event),
        position: eventPositionOf(event) ?? state.position + 1,
        last: eventAt(Object.fromEntries(["type", "turn", "call", "invocationRef"]
          .filter(key => event[key] !== undefined).map(key => [key, event[key]])) as Event, eventPositionOf(event) ?? state.position + 1),
        recorded: key === undefined ? state.recorded : HashSet.add(state.recorded, key),
        refused: key === undefined ? state.refused : state.refused.filter(refusal => refusal.key !== key)
      }, child)
    },

    output: (state, child) => {
      return {
        ...derived(child, state, state.refused.map((record) => {
          if (record.kind === "events") return restoreEventIntent(record.response)
          const work = child.at(record.snapshot).output().transitions.find((work) => work.key === record.work)
          const completion = work === undefined ? undefined : refuse(work, record.measured)
          if (completion === undefined || completion.key !== record.key) throw new Error("budget refusal changed during reconstruction")
          return completion
        }), state.admitted),
        interactions: {
          cancel: (cancellation) => child.output().interactions?.cancel?.(cancellation) ?? []
        }
      }
    }
  })
  return {
    ...component,
    budget: {
      grant: (amount, request, at) => {
        if (multiple) throw new Error("budget grants require a single usage rule")
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("budget grant must be a positive finite number")
        return budgetGranted({ ...request, amount, at })
      },
      deny: (reason, request, at) => budgetDenied({ ...request, reason, at })
    }
  }
}
