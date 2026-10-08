import { AUTH_DEFAULTS, deviceLogin } from "./auth"
import { DEFAULT_BODY_BYTES, DEFAULT_REQUEST_MS, proxy } from "./proxy"

export const DEFAULT_PROXY_PORT = 8789
const key = process.env.PROXY_API_KEY
if (!key) throw new Error("Set PROXY_API_KEY")
const credentials = await deviceLogin(AUTH_DEFAULTS, (url, code) => console.log(`Open ${url} and enter ${code}`))
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PROXY_PORT ?? DEFAULT_PROXY_PORT),
  idleTimeout: 0,
  maxRequestBodySize: Number(process.env.PROXY_BODY_BYTES ?? DEFAULT_BODY_BYTES),
  fetch: proxy({ key, credentials, requestMs: Number(process.env.PROXY_REQUEST_MS ?? DEFAULT_REQUEST_MS) })
})
console.log(`Codex proxy: ${server.url}v1/responses`)
console.log("Codex does not enforce max_output_tokens. The proxy removes this field.")
