import { AUTH_DEFAULTS, deviceLogin } from "./auth"
import { makeProxy, PROXY_DEFAULTS } from "./proxy"
import { timingSafeEqual } from "node:crypto"
import { configuredMcp } from "./mcp-config"
import { object } from "./auth"
import { homedir } from "node:os"

function number(name: string, fallback: number, minimum = 1) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`)
  return value
}

const demo = process.argv.includes("--demo")
const mcpEnabled = process.argv.includes("--mcp")
if (demo && mcpEnabled) throw new Error("--mcp requires live mode")
if (process.argv.includes("--inspect") && !demo) throw new Error("--inspect requires --demo")
const options = {
  ...PROXY_DEFAULTS,
  hostname: process.env.PROXY_HOST ?? PROXY_DEFAULTS.hostname,
  port: number("PROXY_PORT", PROXY_DEFAULTS.port, 0),
  requestMs: number("PROXY_REQUEST_MS", PROXY_DEFAULTS.requestMs),
  maxBodyBytes: number("PROXY_MAX_BODY_BYTES", PROXY_DEFAULTS.maxBodyBytes),
  upstream: process.env.CODEX_UPSTREAM ?? PROXY_DEFAULTS.upstream,
  userAgent: process.env.CODEX_USER_AGENT ?? PROXY_DEFAULTS.userAgent,
  outputLimitPolicy: (process.env.PROXY_OUTPUT_LIMIT_POLICY ?? PROXY_DEFAULTS.outputLimitPolicy) as typeof PROXY_DEFAULTS.outputLimitPolicy,
  apiKey: process.env.PROXY_API_KEY ?? (demo ? "prototype-demo-key" : ""),
}
if (!options.apiKey) throw new Error("Set PROXY_API_KEY before starting the prototype")
if (!["reject", "omit-with-notice"].includes(options.outputLimitPolicy)) throw new Error("Invalid PROXY_OUTPUT_LIMIT_POLICY")

const authOptions = {
  ...AUTH_DEFAULTS,
  issuer: process.env.CODEX_AUTH_ISSUER ?? AUTH_DEFAULTS.issuer,
  clientId: process.env.CODEX_CLIENT_ID ?? AUTH_DEFAULTS.clientId,
  requestMs: number("AUTH_REQUEST_MS", AUTH_DEFAULTS.requestMs),
  loginMs: number("AUTH_LOGIN_MS", AUTH_DEFAULTS.loginMs),
  pollMs: number("AUTH_POLL_MS", AUTH_DEFAULTS.pollMs),
  refreshMarginMs: number("AUTH_REFRESH_MARGIN_MS", AUTH_DEFAULTS.refreshMarginMs, 0),
}

console.log(JSON.stringify({ mode: demo ? "fixture" : "live", ...options, apiKey: "[redacted]", auth: authOptions }))
const credentials = demo
  ? async () => ({ accessToken: "fixture-token", accountId: "fixture-account" })
  : process.env.CODEX_AUTH_SOURCE === "cache"
  ? async () => {
    const auth = object(await Bun.file(`${homedir()}/.codex/auth.json`).json())
    const tokens = object(auth.tokens)
    if (typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string") throw new Error("Codex cache has no ChatGPT access token")
    return { accessToken: tokens.access_token, accountId: tokens.account_id }
  }
  : await deviceLogin(authOptions, (url, code) => console.log(`Open ${url}\nEnter device code: ${code}`))
console.log(`Authentication source: ${demo ? "fixture" : process.env.CODEX_AUTH_SOURCE === "cache" ? "existing Codex cache; renewal remains with Codex" : "device code"}`)

const handler = makeProxy({ ...options, credentials, ...(demo ? { transport: async (request: Request) => {
  const body = await request.json()
  console.log("Fixture upstream request:", JSON.stringify(body))
  const item = { id: "msg_demo", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "The prototype connection works.", annotations: [] }] }
  const response = { id: "resp_demo", object: "response", model: "prototype-fixture", created_at: 0, output: [item], status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  const events = [
    { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0]!.text },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: item.content[0]!.text },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
} } : {}) })

if (process.argv.includes("--inspect")) {
  const response = await handler(new Request("http://prototype/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ model: "prototype-fixture", stream: true, input: [
      { role: "system", content: "Keep the answer short." },
      { role: "user", content: "Check the connection." },
    ] }),
  }))
  console.log("Proxy status:", response.status)
  console.log(await response.text())
  if (response.status !== 200) process.exitCode = 1
} else {
  const mcp = mcpEnabled ? await configuredMcp() : undefined
  const server = Bun.serve({ hostname: options.hostname, port: options.port, idleTimeout: 0, maxRequestBodySize: options.maxBodyBytes, fetch: async (request) => {
    if (!new URL(request.url).pathname.startsWith("/mcp/")) return handler(request)
    const supplied = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${options.apiKey}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return Response.json({ error: "Invalid proxy key" }, { status: 401 })
    if (!mcp) return Response.json({ error: "Start with --mcp" }, { status: 503 })
    try {
      const path = new URL(request.url).pathname
      if (path === "/mcp/tools" && request.method === "GET") return Response.json({ tools: [...(await mcp.tools()).entries()] })
      if (path === "/mcp/call" && request.method === "POST") {
        const body = object(await request.json())
        if (typeof body.name !== "string") return Response.json({ error: "Tool name is required" }, { status: 400 })
        return Response.json(await mcp.call(body.name, body.arguments ?? {}))
      }
      return Response.json({ error: "Unknown MCP route" }, { status: 404 })
    } catch { return Response.json({ error: "MCP call failed; check connection and tool access" }, { status: 502 }) }
  } })
  console.log(`Prototype URL: ${server.url}v1/responses`)
  console.log("Credentials remain in memory. Stop the process to remove them.")
}
