import { RuntimeError } from "../errors"
import { Effect, Schema } from "effect"
import type { EffectValue } from "../effects"

// isEffectValue identifies a tagged description of executable work.
export function isEffectValue(value: unknown): value is EffectValue<unknown, unknown, unknown> {
  return typeof value === "object" && value !== null
    && "kind" in value && value.kind === "effect"
    && "id" in value && typeof value.id === "string" && value.id.length > 0
    && "run" in value && Effect.isEffect(value.run)
}

export const EffectRef = Schema.Struct({
  seq: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  atom: Schema.NonEmptyString,
  tag: Schema.NonEmptyString,
})
export type EffectRef = typeof EffectRef.Type
export const EffectRecord = Schema.Struct({ ref: EffectRef, phase: Schema.Literals(["requested", "settled"]) })
export type EffectRecord = typeof EffectRecord.Type
export type Recorded<Event> = Event & { readonly effect?: EffectRecord }
export interface IdentifiedEffectValue<Event, Error = never, Services = never> extends EffectValue<Event, Error, Services> {
  readonly ref: EffectRef
  readonly tag: string
}
type DirectEffectValue<Value> = Value extends { readonly effect?: infer P } ? Extract<NonNullable<P>, EffectValue<unknown, unknown, unknown>> : never
type CollectedProposals<Value> = Value extends { readonly effects: infer Collection } ? Collection[keyof Collection] : never
export type Proposed<Value> = Extract<Value, EffectValue<unknown, unknown, unknown>> | DirectEffectValue<Value> | Extract<NonNullable<CollectedProposals<Value>>, EffectValue<unknown, unknown, unknown>>
export type FailureOf<P> = P extends EffectValue<unknown, infer Error, unknown> ? Error : never
export type ServicesOf<P> = P extends EffectValue<unknown, unknown, infer Services> ? Services : never
export const effectKey = (ref: EffectRef) => JSON.stringify([ref.seq, ref.atom, ref.tag])

// recordEffect attaches host-owned request or settlement metadata to a domain event.
export function recordEffect<Event extends object>(event: Event, ref: EffectRef, phase: EffectRecord["phase"]): Recorded<Event> {
  if ("effect" in event) throw new RuntimeError("Effect metadata is reserved for the runtime")
  return { ...event, effect: Schema.decodeSync(EffectRecord)({ ref, phase }) }
}
