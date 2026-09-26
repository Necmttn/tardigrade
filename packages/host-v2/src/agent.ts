import { requestEvent, type AgentEvent, type AgentInput } from "@clavia/tardigrade-agent-v2"
import type { Actor } from "@clavia/tardigrade-core-v2"
import { createHost, type HostOptions } from "./host"
import type { Journal } from "./journal"

export function agentHost<State, R, View>(actor: Actor<AgentInput, State, Error, R> & { readonly view: (state: State) => View }, journal: Journal<AgentInput>, options: Omit<HostOptions<AgentInput, R>, "failure">) {
  return createHost(actor, journal, {
    ...options,
    failure: (request, error): AgentEvent => {
      if (request.type === "ActorMethodInvoked" || !requestEvent(request)) throw new Error("Agent effect must carry a request event")
      return { type: "EffectFailed", callId: request.callId, message: error.message }
    },
  })
}
