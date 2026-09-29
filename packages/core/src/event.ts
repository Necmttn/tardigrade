import { Schema, SchemaGetter } from "effect"

/**
 * Event is the smallest data primitive in Tardigrade
 * Every event has a string type and may carry additional fields.
 * Its open shape lets consumers define domain-specific events.
 * Projections are machines that take events as input.
 */
export const Event = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown)
])
export type Event = typeof Event.Type

const positions = new WeakMap<Event, number>()

// eventAt carries a durable log position through projection callbacks without changing the event payload.
export const eventAt = (event: Event, seq: number): Event => {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("event position must be a positive safe integer")
  const positioned = { ...event }
  positions.set(positioned, seq)
  return positioned
}

// eventPositionOf reads the position supplied by full-log replay or incremental reconciliation.
export const eventPositionOf = (event: Event): number | undefined => positions.get(event)


// PositionedEvent preserves reducer-visible event positions through JSON encoding (component/checkpoint.test.ts).
export const PositionedEvent: Schema.Codec<Event, Schema.Json> = Schema.Struct({
  event: Schema.toCodecJson(Event),
  position: Schema.optionalKey(Schema.Int)
}).pipe(Schema.decodeTo(Schema.declare<Event>(Schema.is(Event)), {
  decode: SchemaGetter.transform(({ event, position }) => position === undefined ? event : eventAt(event, position)),
  encode: SchemaGetter.transform(event => {
    const position = eventPositionOf(event)
    return { event, ...(position === undefined ? {} : { position }) }
  })
}))
