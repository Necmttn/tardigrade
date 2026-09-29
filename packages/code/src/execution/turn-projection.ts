import { initialTurnLifecycle, reduceTurnLifecycle, currentTurnFrom } from "./turn-lifecycle"
export { turnTerminalFrom, turnEpochFrom, turnHeadFrom, turnTerminalAtFrom } from "./turn-lifecycle"
import { PositionedEvent } from "@clavia/tardigrade-core/event"
import { Chunk, HashMap, HashSet, Option, Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { eventEpochOf, turnOf } from "./turns"

// TurnProjectionSchema encodes retained turn facts and positioned events without replaying them.
export const TurnProjectionSchema = Schema.Struct({
  nextHead: Schema.Finite,
  heads: Schema.HashMap(Schema.String, Schema.Struct({ event: PositionedEvent, order: Schema.Finite })),
  open: Schema.HashMap(Schema.String, Schema.Finite),
  turns: Schema.HashMap(Schema.String, Schema.Struct({
    events: Schema.Chunk(PositionedEvent), failed: Schema.HashSet(Schema.Finite), resumed: Schema.HashSet(Schema.Finite),
    terminals: Schema.HashMap(Schema.Finite, PositionedEvent), epoch: Schema.Finite
  })),
  served: Schema.HashSet(Schema.String),
  trajectory: Schema.Chunk(PositionedEvent)
})

// TurnProjectionState retains exactly the turn-order facts needed by turnView and trajectoryOf.
export type TurnProjectionState = typeof TurnProjectionSchema.Type
type TurnRecord = typeof TurnProjectionSchema.fields.turns.value.Type

const emptyTurn = (): TurnRecord => ({
  events: Chunk.empty(),
  failed: HashSet.empty(),
  resumed: HashSet.empty(),
  terminals: HashMap.empty(),
  epoch: 0
})

// initialTurnProjection constructs the empty turn quotient.
export const initialTurnProjection = (): TurnProjectionState => ({
  ...initialTurnLifecycle(),
  turns: HashMap.empty(),
  served: HashSet.empty(),
  trajectory: Chunk.empty()
})

const terminal = (event: Event): boolean =>
  event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled"

const reduceTrajectory = (state: TurnProjectionState, event: Event): TurnProjectionState => {
  if (event.type === "MessageReceived") return state
  const id = turnOf(event)
  if (id === undefined || HashSet.has(state.served, id)) {
    return { ...state, trajectory: Chunk.append(state.trajectory, event) }
  }
  const head = Option.getOrUndefined(HashMap.get(state.heads, id))
  return {
    ...state,
    served: HashSet.add(state.served, id),
    trajectory: head === undefined
      ? Chunk.append(state.trajectory, event)
      : Chunk.append(Chunk.append(state.trajectory, head.event), event)
  }
}

// reduceTurnProjection advances the quotient by one durable event.
export const reduceTurnProjection = (state: TurnProjectionState, event: Event): TurnProjectionState => {
  const lifecycle = reduceTurnLifecycle(state, event)
  const id = turnOf(event)
  const turns = id === undefined ? state.turns : HashMap.set(state.turns, id, {
    ...Option.getOrElse(HashMap.get(lifecycle.turns, id), emptyTurn),
    events: Chunk.append(Option.getOrElse(HashMap.get(state.turns, id), emptyTurn).events, event)
  })
  return reduceTrajectory({ ...state, ...lifecycle, turns }, event)
}

// turnViewFrom returns the current active turn from the incremental quotient.
export const turnViewFrom = (state: TurnProjectionState): ReadonlyArray<Event> => {
  const current = currentTurnFrom(state)
  if (current === undefined) return []
  const record = Option.getOrElse(HashMap.get(state.turns, current.id), emptyTurn)
  return [
    current.head.event,
    ...Chunk.toReadonlyArray(record.events).filter((event) => !terminal(event) || eventEpochOf(event) === record.epoch)
  ]
}

// trajectoryFrom returns served conversation order from the incremental quotient.
export const trajectoryFrom = (state: TurnProjectionState): ReadonlyArray<Event> => {
  const projected = Chunk.toReadonlyArray(state.trajectory).filter((event) => {
    const id = turnOf(event)
    if (id === undefined || !terminal(event)) return true
    const record = Option.getOrElse(HashMap.get(state.turns, id), emptyTurn)
    return eventEpochOf(event) === record.epoch
  })
  const current = currentTurnFrom(state)
  return current === undefined || HashSet.has(state.served, current.id)
    ? projected
    : [...projected, current.head.event]
}
