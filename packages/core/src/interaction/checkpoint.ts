import { Schema } from "effect"
import { PositionedEvent } from "../event"
import { ThreadAddress } from "../transport/endpoint"
import { InvocationCoordinate, InvocationRef } from "./invocation"
import { InvocationDetached } from "./detach"
import type { MethodResponseProjectionState } from "./respond"
import type { MethodTimeoutProjectionState } from "./timeout"

const Reply = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("sent"), delivery: Schema.Struct({
    type: Schema.Literal("ResponseDelivered"), method: Schema.String, call: Schema.String,
    epoch: Schema.optionalKey(Schema.Int), at: Schema.Finite
  }) }),
  Schema.Struct({ status: Schema.Literal("detached"), detachment: InvocationDetached })
])

// MethodResponseCheckpoint preserves accepted reply links and delivery state (runtime/checkpoint.properties.test.ts).
export const MethodResponseCheckpoint: Schema.Codec<MethodResponseProjectionState, Schema.Json> = Schema.toCodecJson(Schema.Struct({
  calls: Schema.Array(Schema.Struct({
    owner: PositionedEvent,
    id: Schema.String,
    invocation: Schema.optionalKey(InvocationRef),
    link: Schema.Struct({ source: Schema.Unknown, target: ThreadAddress })
  })),
  replies: Schema.ReadonlyMap(Schema.String, Reply)
}))

// MethodTimeoutCheckpoint preserves deadline ownership and terminal bookkeeping (runtime/checkpoint.properties.test.ts).
export const MethodTimeoutCheckpoint: Schema.Codec<MethodTimeoutProjectionState, Schema.Json> = Schema.toCodecJson(Schema.Struct({
  dispatches: Schema.ReadonlyMap(Schema.String, Schema.Struct({
    reference: InvocationCoordinate,
    owner: PositionedEvent,
    terminal: Schema.Struct({
      reference: Schema.optionalKey(InvocationCoordinate), epoch: Schema.optionalKey(Schema.Int),
      call: Schema.String, method: Schema.String, target: Schema.String,
      timeoutMs: Schema.Finite, deadlineAt: Schema.Finite
    })
  })),
  terminalCalls: Schema.ReadonlySet(Schema.String),
  alarms: Schema.Array(Schema.Struct({
    type: Schema.Literal("AlarmFired"), scheduledFor: Schema.Finite, at: Schema.Finite,
    occurrence: Schema.optionalKey(Schema.Int)
  })),
  deadlines: Schema.ReadonlyMap(Schema.String, Schema.Struct({
    owner: PositionedEvent, invocation: InvocationRef, deadlineAt: Schema.Finite
  })),
  settledInvocations: Schema.ReadonlySet(Schema.String)
}))
