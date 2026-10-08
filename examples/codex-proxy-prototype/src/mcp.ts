import { object } from "./auth"

export const MCP_DEFAULTS = { requestMs: 30_000, maxPages: 20, protocol: "2025-03-26" }
export const MCP_TOOLS = ["appllama_get_credits", "appllama_list_flows"] as const
type Options = typeof MCP_DEFAULTS & {
  url: string
  headers: () => Promise<Record<string, string>>
  transport?: (request: Request) => Promise<Response>
}

async function rpcResult(response: Response, id: string) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`MCP returned ${response.status}`) }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return object(await response.json())
  if (!response.body) throw new Error("MCP returned no stream")
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("MCP stream ended before its response")
      buffer += chunk.value
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (!boundary) break
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
        if (!data) continue
        const value = object(JSON.parse(data))
        if (value.id === id) return value
      }
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}

export function mcpClient(options: Options) {
  let session: string | undefined
  let protocol = options.protocol
  let ready: Promise<void> | undefined
  const rpc = async (method: string, params: unknown, notification = false) => {
    const id = crypto.randomUUID()
    const response = await (options.transport ?? fetch)(new Request(options.url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(options.requestMs),
      headers: {
        ...await options.headers(), "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
        ...(method === "initialize" ? {} : { "mcp-protocol-version": protocol }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    }))
    session = response.headers.get("mcp-session-id") ?? session
    if (notification) {
      await response.body?.cancel()
      if (!response.ok) throw new Error(`MCP notification returned ${response.status}`)
      return {}
    }
    const message = await rpcResult(response, id)
    if (message.id !== id || message.error) throw new Error(`MCP ${method} failed`)
    return object(message.result)
  }
  const initialize = () => ready ??= (async () => {
    const result = await rpc("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "tardigrade-prototype", version: "0.1.0" } })
    if (typeof result.protocolVersion !== "string") throw new Error("MCP protocol is missing")
    protocol = result.protocolVersion
    await rpc("notifications/initialized", {}, true)
  })().catch((error) => { ready = undefined; session = undefined; throw error })
  const tools = async () => {
    await initialize()
    const selected = new Map<string, Record<string, unknown>>()
    let cursor: string | undefined
    for (let page = 0; page < options.maxPages; page++) {
      const result = await rpc("tools/list", cursor ? { cursor } : {})
      if (!Array.isArray(result.tools)) throw new Error("MCP tool list is missing")
      for (const value of result.tools) {
        const tool = object(value)
        if (typeof tool.name !== "string") continue
        const normalized = tool.name.replace(/[^a-zA-Z0-9]/g, "_")
        for (const name of MCP_TOOLS) if (normalized === name) {
          if (selected.has(name)) throw new Error(`Ambiguous MCP tool: ${name}`)
          selected.set(name, tool)
        }
      }
      if (typeof result.nextCursor !== "string") return selected
      cursor = result.nextCursor
    }
    throw new Error(`MCP discovery exceeds maxPages=${options.maxPages}`)
  }
  return {
    tools,
    async call(name: string, args: unknown) {
      if (!(MCP_TOOLS as readonly string[]).includes(name)) throw new Error("Tool is outside the prototype allowlist")
      const tool = (await tools()).get(name)
      if (!tool) throw new Error(`MCPHub does not expose ${name}`)
      return rpc("tools/call", { name: tool.name, arguments: object(args) })
    },
  }
}
