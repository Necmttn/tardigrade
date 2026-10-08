import { timingSafeEqual } from "node:crypto"
import { object, type Credentials } from "./auth"

export const DEFAULT_REQUEST_MS = 180_000
export const DEFAULT_BODY_BYTES = 1_048_576
const upstreamUrl = "https://chatgpt.com/backend-api/codex/responses"

type ProxyOptions = {
  readonly key: string
  readonly credentials: () => Promise<Credentials>
  readonly requestMs?: number
  readonly fetch?: (request: Request) => Promise<Response>
}

// proxy forwards streaming Responses requests using Codex credentials (proxy.test.ts).
export const proxy = (options: ProxyOptions) => async (request: Request): Promise<Response> => {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "")
  const expected = Buffer.from(`Bearer ${options.key}`)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response("Unauthorized", { status: 401 })
  if (new URL(request.url).pathname !== "/v1/responses" || request.method !== "POST") return new Response("Not found", { status: 404 })

  let body: Record<string, unknown>
  try {
    body = object(await request.json())
    if (body.stream !== true) throw new Error("Use stream=true")
    if (typeof body.model !== "string" || !body.model) throw new Error("A model is required")
    const instructions: string[] = []
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== "string") throw new Error("instructions must be a string")
      instructions.push(body.instructions)
    }
    if (!Array.isArray(body.input)) throw new Error("input must be an array")
    let conversation = false
    body.input = body.input.filter((value: unknown) => {
      const message = object(value)
      if (message.role !== "system") { conversation = true; return true }
      if (conversation) throw new Error("System messages must precede the conversation")
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
    delete body.max_output_tokens
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 })
  }

  try {
    const credentials = await options.credentials()
    const response = await (options.fetch ?? fetch)(new Request(upstreamUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "chatgpt-account-id": credentials.accountId,
        "content-type": "application/json",
        accept: "text/event-stream",
        originator: "codex_cli_rs"
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(options.requestMs ?? DEFAULT_REQUEST_MS)])
    }))
    if (!response.ok) {
      await response.body?.cancel()
      return new Response(`Codex returns ${response.status}`, { status: response.status })
    }
    return new Response(response.body, { headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-codex-output-limit": "enforcement=none"
    } })
  } catch {
    return new Response("Codex authentication or request failed", { status: 502 })
  }
}
