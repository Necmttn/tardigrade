import { chmod, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { PROXY_DEFAULTS } from "./proxy"

export const LOCAL_DEFAULTS = { port: 9876, toolRequestMs: 120_000 }
const [major = 0, minor = 0] = Bun.version.split(".").map(Number)
if (major < 1 || (major === 1 && minor < 4)) throw new Error("The Tardigrade runtime requires Bun 1.4 or later")
const root = resolve(import.meta.dir, "..")
const project = resolve(root, "celld")
const repository = resolve(root, "../..")
const model = process.env.CODEX_MODEL
const context = Number(process.env.CODEX_CONTEXT_TOKENS)
if (!model || !Number.isSafeInteger(context) || context <= 0) throw new Error("Set CODEX_MODEL and CODEX_CONTEXT_TOKENS to values for your selected model")
const numeric = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`)
  return value
}
const celldPort = numeric("CELLD_DEV_PORT", LOCAL_DEFAULTS.port)
const proxyPort = numeric("PROXY_PORT", PROXY_DEFAULTS.port)
const toolRequestMs = numeric("TOOL_REQUEST_MS", LOCAL_DEFAULTS.toolRequestMs)
const proxyUrl = `http://127.0.0.1:${proxyPort}`
const runEnv = { ...process.env, PATH: `${repository}/node_modules/.bin:${process.env.PATH ?? ""}` }
const celld = Bun.which("celld", { PATH: runEnv.PATH })
if (!celld) throw new Error("Install Celld before running the local experiment")
if (!Bun.which("esbuild", { PATH: runEnv.PATH })) throw new Error("Install esbuild and add it to PATH")
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
probe.stop(true)

const proxyKey = process.env.PROXY_API_KEY ?? crypto.randomUUID()
const actorKey = process.env.TARDIGRADE_TOKEN ?? crypto.randomUUID()
const reference = { provider: "codex-proxy", model_id: model }
const providers = { "codex-proxy": { protocol: "openai-responses", baseUrl: `${proxyUrl}/v1`, env: ["PROXY_API_KEY"] } }
const lock = { schema: 2, providers, models: [{ ...reference, contextWindowTokens: context, toolCall: true, options: { store: false } }] }
await mkdir(resolve(project, ".generated"), { recursive: true })
await Bun.write(resolve(project, ".generated/settings.json"), JSON.stringify({ lock, proxyUrl, toolRequestMs }, null, 2))
const vars = resolve(project, ".dev.vars")
for (const value of [proxyKey, actorKey]) if (/[\r\n"']/.test(value)) throw new Error("Prototype keys must not contain quotes or newlines")
await Bun.write(vars, [
  `PROXY_API_KEY=${proxyKey}`,
  `TARDIGRADE_TOKEN=${actorKey}`,
  `TARDIGRADE_CONFIG=${JSON.stringify({ models: { default: reference, allow: [referenceToAllow(reference)], providers } })}`,
].join("\n") + "\n", { mode: 0o600 })
await chmod(vars, 0o600)

function referenceToAllow(value: typeof reference) { return { provider: value.provider, model_ids: [value.model_id] } }

const proxy = Bun.spawn([process.execPath, resolve(root, "src/main.ts"), "--mcp"], {
  cwd: repository, env: { ...runEnv, PROXY_API_KEY: proxyKey, PROXY_PORT: String(proxyPort), PROXY_HOST: "127.0.0.1" }, stdout: "inherit", stderr: "inherit",
})
const node = Bun.spawn([celld, "dev", project, "--port", String(celldPort), ...(process.env.CELLD_LOGS === "1" ? ["--logs"] : [])], { cwd: repository, env: runEnv, stdout: "inherit", stderr: "inherit" })
console.log(`Actor URL: http://127.0.0.1:${celldPort}`)
console.log(process.env.CODEX_AUTH_SOURCE === "cache" ? "Using the existing Codex login." : "Complete device authentication before sending an actor message.")
console.log("Run src/ask.ts from this prototype to submit the MCP demonstration.")
const stop = () => { proxy.kill(); node.kill() }
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
try {
  const result = await Promise.race([proxy.exited, node.exited])
  process.exitCode = result
} finally {
  stop()
  await Promise.allSettled([proxy.exited, node.exited])
}
