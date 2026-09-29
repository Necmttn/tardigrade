import { Context, Equal, Hash, Schema, SchemaGetter } from "effect"
import { ComponentCheckpoint } from "../checkpoint"
import type { ComponentReadonly } from "../readonly"
import { eventAt } from "../../event"
import type { Intent } from "../../intent"
import type { ComponentMachine } from "../machine"
import type { Component, ComponentView, ComponentInteractions, ComponentRequirements, ComponentResult } from "../component"
import type { ComponentOutput } from "../output"

// ChildAdmission reserves offered intents without advancing the bound snapshot (children.test.ts).
export interface ChildAdmission<View> {
  readonly output: () => { readonly view: View }
  readonly preview: (proposal: Intent<never>) => ChildAdmission<View>
}

/**
 * ChildHandle binds public queries and interactions to one snapshot (children.test.ts).
 *
 *   Child machine + snapshot
 *             |
 *          bindChild
 *             |
 *         ChildHandle
 *         |-- output()
 *         |     +-- interactions.cancel(...)
 *         +-- admission()
 *                   |
 *              ChildAdmission
 *              |-- output().view
 *              +-- preview(proposal)
 */
const snapshotBrand: unique symbol = Symbol("child.snapshot")

// ChildSnapshot retains a private historical child state without exposing its representation.
export interface ChildSnapshot { readonly [snapshotBrand]: true }
class SnapshotReference implements ChildSnapshot {
  readonly [snapshotBrand] = true;
  [Equal.symbol](other: unknown): boolean { return this === other }
  [Hash.symbol](): number { return Hash.random(this) }
}
const snapshots = new WeakMap<ChildSnapshot, { readonly machine: ComponentMachine<unknown, unknown>; readonly state: unknown; readonly position: number; readonly at: number }>()

export interface ChildHandle<View, Requirements = never, Result = never, Interactions = unknown> {
  readonly output: () => ComponentOutput<View, Requirements, Result, Interactions>
  readonly retain: () => ChildSnapshot
  readonly at: (snapshot: ChildSnapshot) => ChildHandle<View, Requirements, Result, Interactions>
  readonly snapshotSchema?: Schema.Codec<ChildSnapshot, Schema.Json>
  // admission evaluates offered intents without changing the bound snapshot (children.test.ts).
  readonly admission: () => ChildAdmission<View>
}

export type ComponentChildren = Component<unknown, unknown> | ReadonlyArray<Component<unknown, unknown>>

export type ChildOf<C extends ComponentChildren> = C extends Component<unknown, unknown>
  ? ChildHandle<ComponentReadonly<ComponentView<C>>, ComponentRequirements<C>, ComponentResult<C>, ComponentInteractions<C>>
  : { readonly [K in keyof C]: C[K] extends Component<unknown, unknown> ? ChildOf<C[K]> : never }

const admission = (machine: ComponentMachine<unknown, unknown>, snapshot: unknown, position: number, at: number): ChildAdmission<unknown> => {
  const offered = new Set(machine.output(snapshot).transitions)
  const candidate = (state: unknown, head: number, accepted: ReadonlySet<Intent<never>>): ChildAdmission<unknown> => Object.freeze({
    output: () => ({ view: machine.output(state).view }),
    preview: (proposal: Intent<never>) => {
      if (!offered.has(proposal) || proposal.kind !== "intent") throw new Error("admission requires an intent from this child output")
      if (accepted.has(proposal)) throw new Error("admission cannot reserve a proposal twice")
      const events = proposal.events(proposal.input, at)
      const next = events.reduce((current, event, index) => machine.step(current, eventAt(event, head + index + 1)), state)
      return candidate(next, head + events.length, new Set([...accepted, proposal]))
    }
  })
  return candidate(snapshot, position, new Set())
}

// bindChild exposes public operations without revealing its snapshot (children.test.ts).
export const bindChild = (machine: ComponentMachine<unknown, unknown>, snapshot: unknown, position = 0, at = 0, data?: Context.Context<never>): ChildHandle<unknown, unknown, never> => {
  const capture = (state: unknown, position: number, at: number): ChildSnapshot => {
    const reference: ChildSnapshot = Object.freeze(new SnapshotReference())
    snapshots.set(reference, { machine, state, position, at })
    return reference
  }
  const lookup = (reference: ChildSnapshot) => {
    const saved = snapshots.get(reference)
    if (saved === undefined || saved.machine !== machine) throw new Error("Historical snapshot belongs to a different child")
    return saved
  }
  const reference = capture(snapshot, position, at)
  const snapshotSchema = machine.checkpoint === undefined ? undefined : Schema.Struct({
    checkpoint: ComponentCheckpoint, position: Schema.Finite, at: Schema.Finite
  }).pipe(Schema.decodeTo(Schema.declare<ChildSnapshot>((value): value is ChildSnapshot => typeof value === "object" && value !== null && snapshots.get(value as ChildSnapshot)?.machine === machine), {
    decode: SchemaGetter.transform(encoded => capture(machine.checkpoint!.decode(encoded.checkpoint, data), encoded.position, encoded.at)),
    encode: SchemaGetter.transform(value => {
      const saved = lookup(value)
      return { checkpoint: machine.checkpoint!.encode(saved.state), position: saved.position, at: saved.at }
    })
  }))
  const handle: ChildHandle<unknown, unknown, never> = {
    retain: () => reference,
    at: reference => {
      const saved = lookup(reference)
      return bindChild(machine, saved.state, saved.position, saved.at, data)
    },
    ...(snapshotSchema === undefined ? {} : { snapshotSchema }),
    output: () => machine.output(snapshot),
    admission: () => admission(machine, snapshot, position, at)
  }
  return Object.freeze(handle)
}
