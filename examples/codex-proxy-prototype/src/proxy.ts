import { timingSafeEqual } from "node:crypto"
import { object, type Credentials } from "./auth"

export const PROXY_DEFAULTS = {
  hostname: "127.0.0.1",
  port: 8789,
  upstream: "https://chatgpt.com/backend-api/codex/responses",
  requestMs: 180_000,
  maxBodyBytes: 1_048_576,
  userAgent: "codex_cli_rs/0.152.0 (tardigrade-prototype)",
  outputLimitPolicy: "reject" as "reject" | "omit-with-notice",
}

export type ProxyOptions = typeof PROXY_DEFAULTS & {
  apiKey: string
  credentials: () => Promise<Credentials>
  transport?: (request: Request) => Promise<Response>
}

const allowed = new Set(["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "include", "stream", "store", "max_output_tokens"])
const failure = (status: number, message: string) => Response.json({ error: { message, type: "prototype_error" } }, { status })

async function readBody(request: Request, limit: number) {
  if (!request.body) throw new Error("A JSON body is required")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) { await reader.cancel(); throw new Error(`Body exceeds maxBodyBytes=${limit}`) }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}

export function makeProxy(options: ProxyOptions) {
  if (!options.apiKey) throw new Error("PROXY_API_KEY is required")
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0) throw new Error("Invalid maxBodyBytes")
  if (!Number.isSafeInteger(options.requestMs) || options.requestMs <= 0) throw new Error("Invalid requestMs")
  const expected = Buffer.from(`Bearer ${options.apiKey}`)
  return async (request: Request): Promise<Response> => {
    const supplied = Buffer.from(request.headers.get("authorization") ?? "")
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return failure(401, "Invalid proxy key")
    const path = new URL(request.url).pathname
    if (path === "/healthz" && request.method === "GET") return Response.json({
      prototype: true, protocol: "openai-responses", stream: true, store: false,
      requestMs: options.requestMs, maxBodyBytes: options.maxBodyBytes, outputLimitPolicy: options.outputLimitPolicy,
    })
    if (path !== "/v1/responses" || request.method !== "POST") return failure(404, "Use POST /v1/responses")
    let body: Record<string, unknown>
    let omittedLimit: number | undefined
    try {
      body = await readBody(request, options.maxBodyBytes)
      const unsupported = Object.keys(body).filter((key) => !allowed.has(key))
      if (unsupported.length) throw new Error(`Unsupported fields: ${unsupported.join(", ")}`)
      if (body.max_output_tokens != null) {
        if (typeof body.max_output_tokens !== "number" || !Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0) throw new Error("max_output_tokens must be a positive integer")
        if (options.outputLimitPolicy === "reject") throw new Error("Codex does not support max_output_tokens; set outputLimitPolicy=omit-with-notice to accept an unenforced output limit")
        omittedLimit = body.max_output_tokens
      }
      delete body.max_output_tokens
      if (body.stream !== true) throw new Error("The prototype requires stream=true")
      if (body.store !== undefined && body.store !== false) throw new Error("The Codex endpoint requires store=false")
      if (typeof body.model !== "string" || !body.model) throw new Error("A model is required")
      if (body.instructions !== undefined && typeof body.instructions !== "string") throw new Error("instructions must be a string")
      if (typeof body.input === "string") body.input = [{ role: "user", content: [{ type: "input_text", text: body.input }] }]
      if (!Array.isArray(body.input)) throw new Error("input must be a string or an array")
      const instructions: string[] = typeof body.instructions === "string" ? [body.instructions] : []
      let conversation = false
      body.input = body.input.filter((item: unknown) => {
        const message = object(item)
        if (message.role !== "system") { conversation = true; return true }
        if (conversation) throw new Error("Only leading system messages can become instructions")
        if (typeof message.content === "string") instructions.push(message.content)
        else if (Array.isArray(message.content)) instructions.push(message.content.map((value: unknown) => {
          const part = object(value)
          if (part.type !== "input_text" || typeof part.text !== "string") throw new Error("System content must contain input_text")
          return part.text
        }).join("\n"))
        else throw new Error("Invalid system content")
        return false
      })
      body.instructions = instructions.join("\n\n")
      body.store = false
    } catch (error) { return failure(400, error instanceof Error ? error.message : "Invalid request") }
    try {
      const auth = await options.credentials()
      const upstream = await (options.transport ?? fetch)(new Request(options.upstream, {
        method: "POST", body: JSON.stringify(body), redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(options.requestMs)]),
        headers: {
          authorization: `Bearer ${auth.accessToken}`, "chatgpt-account-id": auth.accountId,
          "content-type": "application/json", accept: "text/event-stream",
          originator: "codex_cli_rs", "user-agent": options.userAgent, "OpenAI-Beta": "responses=experimental",
        },
      }))
      if (!upstream.ok) {
        await upstream.body?.cancel()
        const response = failure(upstream.status, `Codex upstream returned ${upstream.status}`)
        const retry = upstream.headers.get("retry-after")
        if (retry) response.headers.set("retry-after", retry)
        return response
      }
      const contentType = upstream.headers.get("content-type")
      if (!upstream.body || (contentType !== null && !contentType.includes("text/event-stream"))) {
        await upstream.body?.cancel()
        return failure(502, "Codex upstream did not return an SSE stream")
      }
      return new Response(upstream.body, { headers: {
        "content-type": "text/event-stream", "cache-control": "no-store",
        "x-codex-prototype-policy": "store=false; leading-system-to-instructions",
        ...(omittedLimit === undefined ? {} : { "x-codex-output-limit": `requested=${omittedLimit}; enforcement=none` }),
      } })
    } catch { return failure(502, "Codex authentication or transport failed; restart and authenticate if necessary") }
  }
}
