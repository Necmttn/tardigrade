import { Effect } from "effect"
import { firstEffect, type MachineEffect, type Actor } from "@clavia/tardigrade-core-v2"
import type { Journal } from "./journal"

export interface HostOptions<Event, R> {
  readonly maxEffects: number
  readonly failure: (request: Event, error: Error) => Event
  readonly select?: (effects: readonly MachineEffect<Event, Error, R>[]) => MachineEffect<Event, Error, R> | undefined
}

// createHost serializes runs through this host and records requests before executing effects.
// Journal revision checks detect competing writers; external side effects still require application idempotency.
export function createHost<Event, State, R, View>(actor: Actor<Event, State, Error, R> & { readonly view: (state: State) => View }, journal: Journal<Event>, options: HostOptions<Event, R>) {
  if (!Number.isSafeInteger(options.maxEffects) || options.maxEffects < 1) throw new Error("maxEffects must be a positive integer")
  let running = false
  const run = (incoming: readonly Event[] = []) => Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        if (running) throw new Error("This host is already running")
        running = true
      },
      catch: error => error instanceof Error ? error : new Error(String(error)),
    }),
    () => Effect.gen(function* () {
      let events = [...yield* journal.read()]
      let state = yield* Effect.try({ try: () => actor.replay(events), catch: error => error instanceof Error ? error : new Error(String(error)) })
      const append = (event: Event) => Effect.gen(function* () {
        const next = yield* Effect.try({ try: () => actor.append(state, event), catch: error => error instanceof Error ? error : new Error(String(error)) })
        yield* journal.append(events.length, event)
        events = [...events, event]
        state = next
      })
      for (const event of incoming) yield* append(event)
      let executed = 0
      while (true) {
        const effects = actor.effects(state)
        const selected = (options.select ?? firstEffect)(effects)
        if (!selected) {
          if (effects.length) return yield* Effect.fail(new Error("Scheduler must select an available effect"))
          return { status: "idle" as const, view: actor.view(state), events }
        }
        if (!effects.includes(selected)) return yield* Effect.fail(new Error("Scheduler selected an effect outside the current snapshot"))
        if (executed >= options.maxEffects) return { status: "limit" as const, message: `Effect limit reached: maxEffects=${options.maxEffects}`, view: actor.view(state), events }
        executed++
        if (!selected.recorded) yield* append(selected.request)
        const result = yield* selected.run.pipe(
          Effect.map(event => ({ ok: true as const, event })),
          Effect.catch(error => Effect.succeed({ ok: false as const, event: options.failure(selected.request, error), error })),
        )
        yield* append(result.event)
        if (!result.ok) return { status: "failed" as const, message: result.error.message, view: actor.view(state), events }
      }
    }),
    () => Effect.sync(() => { running = false }),
  )
  return { run, journal }
}
