import { Context, Effect, PubSub, type Schema, Stream } from "effect"
import type { ThreadCoordinate } from "../actor/thread"
import { RuntimeError, type EffectRef } from "../runtime/effects"

export interface ExecutionUpdatePayload {
  readonly type: string
  readonly [key: string]: Schema.Json
}

export interface ExecutionUpdate {
  readonly address?: ThreadCoordinate
  readonly ref: EffectRef
  readonly attemptId: string
  readonly sequence: number
  readonly payload: ExecutionUpdatePayload
}

export interface ExecutionStreamPolicy {
  readonly bufferCapacity: number
}

export const DEFAULT_EXECUTION_STREAM_POLICY: ExecutionStreamPolicy = { bufferCapacity: 64 }

// ExecutionStream broadcasts ephemeral execution updates within a host lifetime (packages/platform/test/bun/execution-stream.test.ts).
export class ExecutionStream extends Context.Service<ExecutionStream, {
  readonly policy: ExecutionStreamPolicy
  readonly stream: Stream.Stream<ExecutionUpdate>
  readonly publish: (update: ExecutionUpdate) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}>()("tardigrade/ExecutionStream") {}

// createExecutionStream retains recent updates for active subscribers without blocking publishers (packages/platform/test/bun/execution-stream.test.ts).
export const createExecutionStream = (options: Partial<ExecutionStreamPolicy> = {}): Effect.Effect<typeof ExecutionStream.Service, RuntimeError> => Effect.gen(function* () {
  const policy = { ...DEFAULT_EXECUTION_STREAM_POLICY, ...options }
  if (!Number.isSafeInteger(policy.bufferCapacity) || policy.bufferCapacity < 1) return yield* Effect.fail(new RuntimeError("ExecutionStream bufferCapacity must be a positive safe integer"))
  const bus = yield* PubSub.sliding<ExecutionUpdate>(policy.bufferCapacity)
  return {
    policy,
    stream: Stream.fromPubSub(bus),
    publish: update => PubSub.publish(bus, update).pipe(Effect.asVoid),
    close: PubSub.shutdown(bus),
  }
})
