import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { atom, type Atom, durableAtom, effectValue, type EffectValue } from "@clavia/tardigrade-experimental-core"
import { PermissionState, permissionState, type ToolState } from "../projections"
import { PermissionRequests } from "../services/requests"
import { Decision, type Event, type ToolCall } from "../event"

type PermissionView<R> = typeof PermissionState.Type & {
  readonly position: "ready" | "checking" | "waiting"
  readonly effect?: EffectValue<Event, Error, R>
}
type Policy = (call: typeof ToolCall.Type) => typeof Decision.Type

export function permissions(pendingTools: Atom<typeof ToolState.Type>, options: { readonly policy: Policy }): Atom<PermissionView<never>>
export function permissions(pendingTools: Atom<typeof ToolState.Type>): Atom<PermissionView<PermissionRequests>>
export function permissions(pendingTools: Atom<typeof ToolState.Type>, options?: { readonly policy: Policy }): Atom<PermissionView<PermissionRequests>> {
  const decisions = durableAtom({ schema: PermissionState, initial: { requested: [], decisions: [] }, reduce: permissionState })
  return atom(get => {
    const state = get(decisions)
    const call = get(pendingTools).pending
    if (!call || state.decisions.some(value => value.callId === call.callId)) return { ...state, position: "ready" }
    if (options?.policy) return {
      ...state, position: "ready",
      decisions: [...state.decisions, { callId: call.callId, decision: Schema.decodeSync(Decision)(options.policy(call)) }],
    }
    if (state.requested.includes(call.callId)) return { ...state, position: "waiting" }
    return {
      ...state,
      position: "checking",
      effect: effectValue({
        id: call.callId,
        request: { type: "PermissionRequested" as const, callId: call.callId },
        run: Effect.gen(function* () {
          const service = yield* PermissionRequests
          const answer = yield* service.request(call)
          return yield* Schema.decodeEffect(Decision)(answer).pipe(Effect.mapError(RuntimeError.from))
        }).pipe(
          Effect.catch(error => Effect.succeed({ allowed: false, reason: `Permission request failed: ${error.message}` })),
          Effect.map(decision => ({ type: "PermissionResolved" as const, callId: call.callId, decision })),
        ),
      }),
    }
  })
}
