import { createServer } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

export const UI_DEFAULTS = { port: 5173, actorPort: 9876, pollMs: 1000 }
const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}`)
  return value
}
const vars = await Bun.file(resolve(import.meta.dir, "../celld/.dev.vars")).text()
const token = vars.split("\n").find((line) => line.startsWith("TARDIGRADE_TOKEN="))?.slice("TARDIGRADE_TOKEN=".length)
if (!token) throw new Error("Run local.ts before starting the chat interface")
const proxy = {
  target: `http://127.0.0.1:${positive("CELLD_DEV_PORT", UI_DEFAULTS.actorPort)}`,
  headers: { authorization: `Bearer ${token}` },
}
const server = await createServer({
  configFile: false,
  root: resolve(import.meta.dir, "../../react-rlm-chat/web"),
  plugins: [react()],
  define: {
    "import.meta.env.VITE_ACTOR_ID": JSON.stringify("demo"),
    "import.meta.env.VITE_EVENT_POLL_MS": JSON.stringify(positive("UI_POLL_MS", UI_DEFAULTS.pollMs)),
    "import.meta.env.VITE_CHAT_TITLE": JSON.stringify("Codex · MCPHub · Celld"),
    "import.meta.env.VITE_CHAT_NOTICE": JSON.stringify("Prototype: Codex does not enforce the requested output token limit."),
  },
  server: {
    host: "127.0.0.1", port: positive("UI_PORT", UI_DEFAULTS.port), strictPort: true,
    proxy: { "/v1": proxy, "/healthz": proxy },
  },
})
await server.listen()
server.printUrls()
console.log("The chat interface connects to the local Celld actor. The access key stays in the server.")
const stop = async () => { await server.close(); process.exit() }
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
