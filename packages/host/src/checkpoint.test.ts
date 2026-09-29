import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { actorFromProjections, type ActorCheckpoint } from "@clavia/tardigrade-core/runtime"
import { EventLog } from "@clavia/tardigrade-core/log"
import type { Event } from "@clavia/tardigrade-core/event"
import { intent } from "@clavia/tardigrade-core/intent"
import { transitionProjection } from "@clavia/tardigrade-core/transition"
import { actorExecution } from "./execution"
import type { ActorCheckpointPersistence } from "./checkpoint"

const worker = () => actorFromProjections({
  transitions: [transitionProjection({
    checkpoint: {
      encode: Schema.encodeSync(Schema.Array(Schema.String)),
      decode: (state) => Schema.decodeUnknownSync(Schema.Array(Schema.String))(state)
    },
    initial: (): ReadonlyArray<string> => [],
    step: (state: ReadonlyArray<string>, event: Event) => event.type === "Start" ? [...state, String(event.id)] : state,
    output: (state: ReadonlyArray<string>) => state.map((id) => intent({ key: id, input: id, events: (id) => [{ type: "Done", id }] }))
  })],
  keyOf: (event) => event.type === "Done" ? String(event.id) : undefined
})

test("failed checkpoint replacement preserves the previous prefix and recovery does not repeat committed work", async () => {
  const events: Array<Event> = [{ type: "Start", id: "first" }]
  const log = Layer.succeed(EventLog, {
    append: (batch: ReadonlyArray<Event>) => Effect.sync(() => { events.push(...batch) }),
    read: Effect.sync(() => [...events]), head: Effect.sync(() => events.length),
    readFrom: (mark: number) => Effect.sync(() => events.slice(mark))
  })
  let saved: ActorCheckpoint | undefined
  let fail = false
  let saves = 0
  const persistence: ActorCheckpointPersistence = {
    identity: { actor: "worker", version: "1", stream: "stream" },
    store: {
      load: Effect.sync(() => saved === undefined ? undefined : JSON.parse(JSON.stringify(saved))),
      save: (checkpoint) => Effect.sync(() => {
        saves++
        if (fail) throw new Error("disk full")
        saved = JSON.parse(JSON.stringify(checkpoint)) as ActorCheckpoint
      })
    }
  }
  const first = actorExecution(worker(), persistence)
  await Effect.runPromise(first.settle.pipe(Effect.provide(log)))
  const prefix = saved!.watermark
  events.push({ type: "Start", id: "second" })
  fail = true
  await expect(Effect.runPromise(first.settle.pipe(Effect.provide(log)))).rejects.toThrow("disk full")
  expect(saved!.watermark).toBe(prefix)
  expect(events.filter((event) => event.type === "Done")).toHaveLength(2)
  fail = false
  const restarted = actorExecution(worker(), persistence)
  await Effect.runPromise(restarted.settle.pipe(Effect.provide(log)))
  expect(saved!.watermark).toBe(events.length)
  expect(events.filter((event) => event.type === "Done")).toHaveLength(2)
  await Effect.runPromise(restarted.settle.pipe(Effect.provide(log)))
  expect(saves).toBe(3)
})
