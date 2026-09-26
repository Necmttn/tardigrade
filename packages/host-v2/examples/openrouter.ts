import { Config, Effect, Layer } from "effect"
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { FetchHttpClient } from "effect/unstable/http"
import { PermissionChecker, toolLayer } from "@clavia/tardigrade-agent-v2"
import { languageModelServices } from "@clavia/tardigrade-agent-v2/layers/language-model"
import { exampleTools } from "./tools"

export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5"
export const DEFAULT_MAX_TOKENS = 2048
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000

export const liveServices = Effect.gen(function* () {
  const apiKey = yield* Config.Redacted("OPENROUTER_API_KEY")
  const model = yield* Config.String("OPENROUTER_MODEL").pipe(Config.withDefault(DEFAULT_MODEL))
  const maxTokens = yield* Config.Number("MAX_TOKENS").pipe(Config.withDefault(DEFAULT_MAX_TOKENS))
  const timeoutMs = yield* Config.Number("MODEL_TIMEOUT_MS").pipe(Config.withDefault(DEFAULT_MODEL_TIMEOUT_MS))
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) return yield* Effect.fail(new Error("MAX_TOKENS must be a positive integer"))
  const provider = OpenRouterLanguageModel.layer({ model, config: { max_tokens: maxTokens, parallel_tool_calls: false } }).pipe(
    Layer.provide(OpenRouterClient.layer({ apiKey })),
    Layer.provide(FetchHttpClient.layer),
  )
  const models = languageModelServices({
    timeoutMs,
    cost: response => {
      const metadata = response.content.find(part => part.type === "finish")?.metadata.openrouter as { usage?: { cost?: number } } | undefined
      const cost = metadata?.usage?.cost
      if (typeof cost !== "number") throw new Error("OpenRouter did not report usage.cost")
      return cost
    },
    onUsage: (kind, cost) => console.error(`${kind}: $${cost.toFixed(6)}`),
  }).pipe(Layer.provide(provider))
  console.error(`OpenRouter: ${model}; maxTokens=${maxTokens}; timeoutMs=${timeoutMs}`)
  return Layer.mergeAll(
    models,
    toolLayer(exampleTools),
    Layer.succeed(PermissionChecker, { check: call => Effect.succeed(exampleTools.some(tool => tool.spec.name === call.name)
      ? { allowed: true as const } : { allowed: false as const, reason: `Unknown tool: ${call.name}` }) }),
  )
})
