import { HashMap, Option, Schema } from "effect"
import { eventAt, eventPositionOf, type Event } from "@clavia/tardigrade-core/event"
import { TurnLifecycleSchema, initialTurnLifecycle, reduceTurnLifecycle, currentTurnFrom, turnEpochFrom } from "@clavia/tardigrade-code/execution/turn-lifecycle"
import { turnOf } from "@clavia/tardigrade-code/execution/turns"

const Allowance = Schema.Struct({ granted: Schema.Finite, initial: Schema.Boolean, phase: Schema.Literals(["spending", "exhausted", "denied"]) })
const emptyAllowance = (): typeof Allowance.Type => ({ granted: 0, initial: false, phase: "spending" })
export const BudgetLedgerSchema = Schema.Struct({ turns: TurnLifecycleSchema, allowances: Schema.HashMap(Schema.String, Allowance) })
export type BudgetLedger = typeof BudgetLedgerSchema.Type

export const initialBudgetLedger = (): BudgetLedger => ({ turns: initialTurnLifecycle(), allowances: HashMap.empty() })

export const reduceBudgetLedger = (state: BudgetLedger, event: Event): BudgetLedger => {
  const position = eventPositionOf(event)
  const facts = Object.fromEntries(["type", "id", "turn", "epoch", "failedEpoch", "budget", "call", "invocationRef"]
    .filter(key => event[key] !== undefined).map(key => [key, event[key]])) as Event
  const turns = reduceTurnLifecycle(state.turns, position === undefined ? facts : eventAt(facts, position))
  const turn = turnOf(event)
  if (turn === undefined || !["BudgetGranted", "BudgetExhausted", "BudgetDenied", "MessageReceived"].includes(event.type)) return { ...state, turns }
  const previous = Option.getOrElse(HashMap.get(state.allowances, turn), emptyAllowance)
  const granted = event.type === "BudgetGranted"
  return { turns, allowances: HashMap.set(state.allowances, turn, {
    granted: previous.granted + (granted ? Number(event.amount ?? 0) : 0),
    initial: previous.initial || granted && event.initial === true,
    phase: event.type === "BudgetExhausted" ? "exhausted" : event.type === "BudgetDenied" ? "denied" : "spending"
  }) }
}

export const budgetTurnFrom = (state: BudgetLedger) => {
  const current = currentTurnFrom(state.turns)
  const allowance = current === undefined ? emptyAllowance() : Option.getOrElse(HashMap.get(state.allowances, current.id), emptyAllowance)
  return { ...allowance, head: current?.head.event, epoch: current === undefined ? 0 : turnEpochFrom(state.turns, current.id) }
}
