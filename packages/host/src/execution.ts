import type { ActorCheckpointPersistence } from "./checkpoint"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorRuntimeOf, createActorReconciler, restingActor, type ActorSource } from "@clavia/tardigrade-core/runtime"

// actorExecution retains reconciliation state between drives (platform/cloudflare/test/actor.workers.ts).
export const actorExecution = <R>(actor: ActorSource<R>, checkpoint?: ActorCheckpointPersistence) => {
  const runtime = actorRuntimeOf(actor)
  let reconciler = checkpoint === undefined ? createActorReconciler(runtime) : undefined
  let savedWatermark: number | undefined
  let reported = false
  const settle = Effect.gen(function* () {
    if (reconciler === undefined) {
      const restore = yield* checkpoint!.store.load
      reconciler = createActorReconciler(runtime, { checkpoint: checkpoint!.identity, restore })
    }
    yield* reconciler.settle
    if (checkpoint !== undefined) {
      if (!reported) {
        checkpoint.onRecovery?.(reconciler.recovery())
        reported = true
      }
      const saved = reconciler.checkpoint()
      if (saved.watermark !== savedWatermark) {
        yield* checkpoint.store.save(saved)
        savedWatermark = saved.watermark
      }
    }
  })
  let settled = false
  return {
    settle: settle.pipe(Effect.tap(() => Effect.sync(() => { settled = true }))),
    isResting: (read: Effect.Effect<ReadonlyArray<Event>>) => Effect.suspend(() => settled
      ? Effect.sync(() => reconciler!.isResting())
      : Effect.gen(function* () {
          const data = yield* Effect.context<never>()
          return restingActor(actor, yield* read, data)
        }))
  }
}

// threadExecutions replaces cached execution when a thread's actor definition changes (platform/bun/src/host.test.ts).
export const threadExecutions = <R>() => {
  const entries = new Map<string, { readonly actor: ActorSource<R>; readonly execution: ReturnType<typeof actorExecution<R>> }>()
  return (thread: string, actor: ActorSource<R>, checkpoint?: ActorCheckpointPersistence) => {
    let entry = entries.get(thread)
    if (entry?.actor !== actor) {
      entry = { actor, execution: actorExecution(actor, checkpoint) }
      entries.set(thread, entry)
    }
    return entry.execution
  }
}
