import { Effect } from "effect"

export interface Journal<Event> {
  readonly read: () => Effect.Effect<readonly Event[], Error>
  readonly append: (expectedRevision: number, event: Event) => Effect.Effect<void, Error>
}

// memoryJournal appends only at the expected revision and keeps values in memory.
export function memoryJournal<Event>(initial: readonly Event[] = []): Journal<Event> {
  let events = structuredClone([...initial])
  return {
    read: () => Effect.try({ try: () => structuredClone(events), catch: error => new Error(String(error)) }),
    append: (expectedRevision, event) => Effect.try({
      try: () => {
        if (events.length !== expectedRevision) throw new Error(`Journal conflict: expected ${expectedRevision}, found ${events.length}`)
        events = [...events, structuredClone(event)]
      },
      catch: error => error instanceof Error ? error : new Error(String(error)),
    }),
  }
}
