import { ActorCheckpointStore } from "./checkpoint"
import { Cause, Effect, Option } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorRuntimeOf, createActorReconciler, restingActor, type ActorSource } from "@clavia/tardigrade-core/runtime"

// actorExecution retains reconciliation state between drives (platform/cloudflare/test/actor.workers.ts).
export const actorExecution = <R>(actor: ActorSource<R>) => {
  let reconciler = createActorReconciler(actorRuntimeOf(actor))
  let loaded = false
  let savedWatermark: number | undefined
  const bestEffort = <A, E, Env>(operation: string, effect: Effect.Effect<A, E, Env>) => effect.pipe(
    Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logWarning(`Actor checkpoint ${operation} failed`, cause).pipe(Effect.as(undefined)))
  )
  let settled = false
  return {
    settle: Effect.gen(function* () {
      const store = reconciler.supportsCheckpoints ? Option.getOrUndefined(yield* Effect.serviceOption(ActorCheckpointStore)) : undefined
      if (!loaded) {
        if (store !== undefined) {
          const checkpoint = yield* bestEffort("load", store.load)
          if (checkpoint !== undefined) {
            const restored = createActorReconciler(actorRuntimeOf(actor), { checkpoint })
            const validated = yield* bestEffort("restore", restored.checkpoint)
            if (validated !== undefined) reconciler = restored
          }
        }
        loaded = true
      }
      yield* reconciler.settle
      settled = true
      if (store !== undefined) {
        const checkpoint = yield* bestEffort("capture", reconciler.checkpoint)
        if (checkpoint !== undefined && checkpoint.watermark !== savedWatermark) {
          const saved = yield* bestEffort("save", store.save(checkpoint).pipe(Effect.as(true)))
          if (saved) savedWatermark = checkpoint.watermark
        }
      }
    }),
    isResting: (read: Effect.Effect<ReadonlyArray<Event>>) => Effect.suspend(() => settled
      ? Effect.sync(() => reconciler.isResting())
      : Effect.gen(function* () {
          const data = yield* Effect.context<never>()
          return restingActor(actor, yield* read, data)
        }))
  }
}

// threadExecutions replaces cached execution when a thread's actor definition changes (platform/bun/src/host.test.ts).
export const threadExecutions = <R>() => {
  const entries = new Map<string, { readonly actor: ActorSource<R>; readonly execution: ReturnType<typeof actorExecution<R>> }>()
  return (thread: string, actor: ActorSource<R>) => {
    let entry = entries.get(thread)
    if (entry?.actor !== actor) {
      entry = { actor, execution: actorExecution(actor) }
      entries.set(thread, entry)
    }
    return entry.execution
  }
}
