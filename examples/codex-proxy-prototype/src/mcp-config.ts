import { homedir } from "node:os"
import { object } from "./auth"
import { mcpClient, MCP_DEFAULTS } from "./mcp"

export async function configuredMcp() {
  const path = process.env.CODEX_CONFIG_FILE ?? `${homedir()}/.codex/config.toml`
  const config = object(Bun.TOML.parse(await Bun.file(path).text()))
  const server = object(object(config.mcp_servers)[process.env.MCP_SERVER_NAME ?? "mcphub"])
  if (typeof server.url !== "string") throw new Error("MCPHub HTTP URL is missing")
  const number = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`)
    return value
  }
  return mcpClient({
    ...MCP_DEFAULTS, url: server.url,
    requestMs: number("MCP_REQUEST_MS", MCP_DEFAULTS.requestMs),
    maxPages: number("MCP_MAX_PAGES", MCP_DEFAULTS.maxPages),
    headers: async () => {
      const headers: Record<string, string> = {}
      if (server.http_headers) for (const [key, value] of Object.entries(object(server.http_headers))) {
        if (typeof value !== "string") throw new Error("Invalid MCP header")
        headers[key] = value
      }
      if (typeof server.bearer_token_env_var === "string") {
        const token = process.env[server.bearer_token_env_var]
        if (!token) throw new Error("MCP token environment variable is missing")
        headers.authorization = `Bearer ${token}`
      }
      if (typeof server.http_headers_helper === "string") {
        const child = Bun.spawn(["/bin/sh", "-c", server.http_headers_helper], { stdout: "pipe", stderr: "ignore" })
        const output = await new Response(child.stdout).text()
        if (await child.exited !== 0) throw new Error("MCP header helper failed")
        for (const [key, value] of Object.entries(object(JSON.parse(output)))) {
          if (typeof value !== "string") throw new Error("Invalid MCP helper header")
          headers[key] = value
        }
      }
      return headers
    },
  })
}
