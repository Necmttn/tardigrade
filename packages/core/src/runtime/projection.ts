import { Context, Schema } from "effect"
import { ComponentCheckpoint } from "../component/checkpoint"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Component } from "@clavia/tardigrade-core/component"
import type { ActorProjection, Self } from "@clavia/tardigrade-core/runtime/reconciler"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { Router } from "../transport/router"
import { CANCELLATION_CONTROL_METHOD, actorCancellationComponentTransitions, actorCancellationMethodStates, actorCancellationProjection, cancellationMethodStateOf } from "../interaction/cancellation"
import { MethodResponseState, initialMethodResponseState, methodResponseTransitions, reduceMethodResponseState, type MethodResponseProjectionState } from "../interaction/respond"
import { MethodTimeoutState, initialMethodTimeoutState, methodTimeoutTransitions, reduceMethodTimeoutState, type MethodTimeoutProjectionState } from "../interaction/timeout"
import type { ActorMethods } from "../actor/method"

interface ActorProjectionState {
  readonly cancellation: unknown
  readonly response: MethodResponseProjectionState
  readonly timeout: MethodTimeoutProjectionState
}

// actorProjection owns component, method, response, timeout, and cancellation state for one actor log.
export const actorProjection = <R>(
  methods: ActorMethods,
  responseMethods: ActorMethods,
  components: ReadonlyArray<Component<unknown, R>>,
  keyOf: (event: Event) => string | undefined,
  childTimeoutMs: number
): ActorProjection<R | Router | Self> => {
  const cancellation = actorCancellationProjection(methods, components, keyOf, childTimeoutMs)!
  const ownCodec = Schema.toCodecJson(Schema.Struct({ response: MethodResponseState, timeout: MethodTimeoutState }))
  return {
    ...(cancellation.checkpoint === undefined ? {} : { checkpoint: {
      encode: (erased: unknown): ComponentCheckpoint => {
        const state = erased as ActorProjectionState
        return { component: "actor.control", version: "1", state: Schema.encodeSync(ownCodec)(state), children: [cancellation.checkpoint!.encode(state.cancellation)] }
      },
      decode: (candidate: unknown, data?: Context.Context<never>): ActorProjectionState => {
        const saved = Schema.decodeUnknownSync(ComponentCheckpoint)(candidate)
        if (saved.component !== "actor.control" || saved.version !== "1" || saved.children.length !== 1) throw new Error("Incompatible actor control checkpoint")
        return { ...Schema.decodeSync(ownCodec)(saved.state), cancellation: cancellation.checkpoint!.decode(saved.children[0], data) }
      }
    } }),
    initial: (data): ActorProjectionState => ({
      cancellation: cancellation.initial(data),
      response: initialMethodResponseState(),
      timeout: initialMethodTimeoutState()
    }),
    step: (erased, event): ActorProjectionState => {
      const state = erased as ActorProjectionState
      return {
        cancellation: cancellation.step(state.cancellation, event),
        response: reduceMethodResponseState(state.response, event),
        timeout: reduceMethodTimeoutState(state.timeout, event)
      }
    },
    output: (erased) => {
      const state = erased as ActorProjectionState
      const methodStates = actorCancellationMethodStates(state.cancellation)
      const cancellationOutput = cancellation.output(state.cancellation)
      const continuations = [
        ...actorCancellationComponentTransitions(state.cancellation, components),
        ...methodTimeoutTransitions(methods, methodStates, state.timeout),
        ...methodResponseTransitions(
          responseMethods,
          state.response,
          (name, method, invocation) => name === CANCELLATION_CONTROL_METHOD
            ? cancellationMethodStateOf(methods, state.cancellation, invocation)
            : method.projection.output(methodStates.get(name)).invocationState(invocation)
        )
      ] as ReadonlyArray<Transition<never, R | Router | Self>>
      return {
        continuations,
        cancellationOf: cancellationOutput.cancellationOf,
        suppresses: cancellationOutput.suppresses,
        residuals: cancellationOutput.residuals
      }
    }
  }
}
