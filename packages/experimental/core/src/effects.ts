import { Effect } from "effect"

// EffectValue settles with an event or an ordered, nonempty batch committed together by the host.
export interface EffectValue<Event, Error = never, Services = never> {
  readonly kind: "effect"
  readonly id: string
  readonly request?: Event
  readonly run: Effect.Effect<Event | readonly Event[], Error, Services>
}
export type EffectValues<Event, Error = never, Services = never> = Readonly<Record<string, EffectValue<Event, Error, Services>>>

// effectValue describes host-executed work without starting it.
export function effectValue<Request extends object, Result extends object, Error, Services>(value: {
  readonly id: string
  readonly request: Request
  readonly run: Effect.Effect<Result | readonly Result[], Error, Services>
}): EffectValue<Request | Result, Error, Services> {
  if (!value.id) throw new Error("Effect identity must not be empty")
  return { ...value, kind: "effect" }
}

// eventValue describes a local event delivery without a separate request event.
export function eventValue<Event extends object>(value: { readonly id: string; readonly event: Event }): EffectValue<Event> {
  if (!value.id) throw new Error("Effect identity must not be empty")
  return { kind: "effect", id: value.id, run: Effect.succeed(value.event) }
}
