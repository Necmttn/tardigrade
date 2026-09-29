import { PositionedEvent } from "@clavia/tardigrade-core/event"
import { HashMap, HashSet, Option, Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { eventEpochOf, turnOf } from "./turns"

export const TurnLifecycleSchema = Schema.Struct({
  nextHead: Schema.Finite,
  heads: Schema.HashMap(Schema.String, Schema.Struct({ event: PositionedEvent, order: Schema.Finite })),
  open: Schema.HashMap(Schema.String, Schema.Finite),
  turns: Schema.HashMap(Schema.String, Schema.Struct({
    failed: Schema.HashSet(Schema.Finite), resumed: Schema.HashSet(Schema.Finite),
    terminals: Schema.HashMap(Schema.Finite, PositionedEvent), epoch: Schema.Finite
  }))
})

// TurnLifecycleState retains message identities and epoch outcomes without execution history (checkpoint.test.ts).
export type TurnLifecycleState = typeof TurnLifecycleSchema.Type
type TurnRecord = typeof TurnLifecycleSchema.fields.turns.value.Type
type TurnHeadRecord = typeof TurnLifecycleSchema.fields.heads.value.Type

const emptyTurn = (): TurnRecord => ({ failed: HashSet.empty(), resumed: HashSet.empty(), terminals: HashMap.empty(), epoch: 0 })

// initialTurnLifecycle constructs empty lifecycle facts (checkpoint.test.ts).
export const initialTurnLifecycle = (): TurnLifecycleState => ({ nextHead: 0, heads: HashMap.empty(), open: HashMap.empty(), turns: HashMap.empty() })

const field = (event: Event, name: string): string =>
  String((event as Record<string, unknown>)[name] ?? "")

const terminal = (event: Event): boolean =>
  event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled"

const advanceEpoch = (record: TurnRecord): number => {
  let epoch = record.epoch
  while (HashSet.has(record.failed, epoch) && HashSet.has(record.resumed, epoch)) epoch += 1
  return epoch
}

const reduceHead = (state: TurnLifecycleState, event: Event): TurnLifecycleState => {
  if (event.type !== "MessageReceived") return state
  const id = field(event, "id")
  if (HashMap.has(state.heads, id)) return state
  const turn = Option.getOrElse(HashMap.get(state.turns, id), emptyTurn)
  return {
    ...state,
    nextHead: state.nextHead + 1,
    heads: HashMap.set(state.heads, id, { event, order: state.nextHead }),
    open: HashMap.has(turn.terminals, turn.epoch)
      ? state.open
      : HashMap.set(state.open, id, state.nextHead)
  }
}

const reduceTurn = (state: TurnLifecycleState, event: Event): TurnLifecycleState => {
  if (!terminal(event) && event.type !== "TurnResumed") return state
  const id = turnOf(event)
  if (id === undefined) return state
  const previous = Option.getOrElse(HashMap.get(state.turns, id), emptyTurn)
  const eventEpoch = eventEpochOf(event)
  const failed = event.type === "TurnFailed" ? HashSet.add(previous.failed, eventEpoch) : previous.failed
  const failedEpoch = event.type === "TurnResumed"
    ? Number((event as { readonly failedEpoch?: unknown }).failedEpoch ?? 0)
    : undefined
  const resumed = failedEpoch === undefined || eventEpoch !== failedEpoch + 1
    ? previous.resumed
    : HashSet.add(previous.resumed, failedEpoch)
  const terminals = terminal(event) ? HashMap.set(previous.terminals, eventEpoch, event) : previous.terminals
  const record = {
    ...previous,
    failed,
    resumed,
    terminals,
    epoch: advanceEpoch({ ...previous, failed, resumed, terminals })
  }
  if (!HashMap.has(state.heads, id)) return { ...state, turns: HashMap.set(state.turns, id, record) }
  const head = Option.getOrUndefined(HashMap.get(state.heads, id))!
  return {
    ...state,
    turns: HashMap.set(state.turns, id, record),
    open: HashMap.has(record.terminals, record.epoch)
      ? HashMap.remove(state.open, id)
      : HashMap.set(state.open, id, head.order)
  }
}

// reduceTurnLifecycle folds only heads, terminal outcomes, and resume links (checkpoint.test.ts).
export const reduceTurnLifecycle = (state: TurnLifecycleState, event: Event): TurnLifecycleState => reduceTurn(reduceHead(state, event), event)

// currentTurnFrom selects the earliest accepted head without a terminal in its active epoch (checkpoint.test.ts).
export const currentTurnFrom = (state: TurnLifecycleState): { readonly id: string; readonly head: TurnHeadRecord } | undefined => {
  let current: { readonly id: string; readonly head: TurnHeadRecord } | undefined
  for (const [id, order] of HashMap.entries(state.open)) {
    const head = Option.getOrUndefined(HashMap.get(state.heads, id))
    if (head !== undefined && (current === undefined || order < current.head.order)) current = { id, head }
  }
  return current
}


// turnTerminalFrom returns the terminal for one turn's active epoch.
export const turnTerminalFrom = (state: TurnLifecycleState, turn: string): Event | undefined => {
  const record = Option.getOrElse(HashMap.get(state.turns, turn), emptyTurn)
  return Option.getOrUndefined(HashMap.get(record.terminals, record.epoch))
}

// turnEpochFrom returns one turn's active execution epoch.
export const turnEpochFrom = (state: TurnLifecycleState, turn: string): number =>
  Option.getOrElse(HashMap.get(state.turns, turn), emptyTurn).epoch

// turnHeadFrom returns one named turn's accepted head.
export const turnHeadFrom = (state: TurnLifecycleState, turn: string): Event | undefined =>
  Option.getOrUndefined(HashMap.get(state.heads, turn))?.event

// turnTerminalAtFrom returns one named turn's terminal at an execution epoch.
export const turnTerminalAtFrom = (state: TurnLifecycleState, turn: string, epoch: number): Event | undefined =>
  Option.getOrUndefined(HashMap.get(
    Option.getOrElse(HashMap.get(state.turns, turn), emptyTurn).terminals,
    epoch
  ))
