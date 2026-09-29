import { Effect, Layer } from "effect"
import { actor } from "@clavia/tardigrade-core/actor"
import { definePackage } from "@clavia/tardigrade-code/package/definition"
import { agentMethods } from "../actor/methods"
import { infer } from "../component/infer"
import { codeMode } from "../component/code"
import { tool } from "../component/tool"
import { budget } from "../component/budget"
import { permissions } from "../component/permissions"
import { compact } from "../component/compact"
import { messages } from "../component/messages"
import { system } from "../component/system"
import { nativeOutput } from "../component/native-output"
import { outputRepair } from "../component/repair"
import { NativeOutputSupport } from "../model/contract"
import { testInferenceLayer } from "./model"

// checkpointAgent constructs a complete scripted agent for restart tests and benchmarks.
export const checkpointAgent = (options: {
  readonly mode?: "code" | "native"
  readonly limit?: number
  readonly callsPerTurn?: number
  readonly onTool?: () => void
  readonly onModel?: () => void
} = {}) => {
  const count = options.callsPerTurn ?? 1
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("callsPerTurn must be a positive integer")
  const run = (input: unknown) => Effect.sync(() => { options.onTool?.(); return input })
  const surface = options.mode === "native"
    ? tool({ spec: { name: "echo", description: "Echo the input", inputSchema: {} }, run })
    : codeMode([definePackage({ name: "probe", description: "Echo package", methods: { echo: run } })])
  const guarded = permissions(surface, { request: () => undefined, onDenied: (reason, respond) => respond({ error: reason }) })
  const definition = actor({
    name: "checkpoint-agent", methods: agentMethods,
    components: [infer([
      budget(guarded, { limit: options.limit ?? 100, usage: (view) => view.calls.length, onExhausted: (reason, respond) => respond({ error: reason }) }),
      compact(messages()), system("Use the echo tool, then answer."), options.mode === "native" ? outputRepair : nativeOutput
    ], { models: { default: { provider: "test", model_id: "checkpoint" }, allow: "*" } })]
  })
  const layers = Layer.merge(testInferenceLayer({
    resolve: (model = { provider: "test", model_id: "checkpoint" }) => ({ model, contextWindowTokens: 1_000_000_000 }),
    react: (request) => Effect.sync(() => {
      options.onModel?.()
      const returned = request.trajectory.find((event) => event.type === "ToolReturned" && event.turn === request.identity.turn)
      const call = (index: number) => ({ callId: `call-${index}`, name: options.mode === "native" ? "echo" : "execute",
        arguments: options.mode === "native" ? { text: "echo" } : { code: 'return await probe.echo({ text: "echo" })' } })
      return returned === undefined ? {
        kind: "calls" as const,
        calls: [call(0), ...Array.from({ length: count - 1 }, (_, index) => call(index + 1))] as const
      } : { kind: "complete" as const, output: JSON.stringify(returned.result) }
    })
  }), Layer.succeed(NativeOutputSupport, { withTools: true }))
  return { definition, layers }
}
