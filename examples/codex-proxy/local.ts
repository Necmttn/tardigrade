import { chmod } from "node:fs/promises"
import { resolve } from "node:path"
import modelLock from "./celld/models.lock.json"

export const DEFAULT_ACTOR_PORT = 9876
const model = modelLock.models[0]!
if (model.model_id === "YOUR_MODEL_ID") throw new Error("Set your model and context window in celld/models.lock.json")
const project = resolve(import.meta.dir, "celld")
const key = crypto.randomUUID()
const token = crypto.randomUUID()
const vars = resolve(project, ".dev.vars")
await Bun.write(vars, [
  `PROXY_API_KEY=${key}`,
  `TARDIGRADE_TOKEN=${token}`,
  `TARDIGRADE_CONFIG=${JSON.stringify({ models: { default: { provider: model.provider, model_id: model.model_id }, allow: [{ provider: model.provider, model_ids: [model.model_id] }], providers: modelLock.providers } })}`
].join("\n") + "\n", { mode: 0o600 })
await chmod(vars, 0o600)
const env = { ...process.env, PROXY_API_KEY: key, PATH: `${resolve(import.meta.dir, "../../node_modules/.bin")}:${process.env.PATH ?? ""}` }
const proxy = Bun.spawn([process.execPath, resolve(import.meta.dir, "serve.ts")], { env, stdout: "inherit", stderr: "inherit" })
const celld = Bun.spawn(["celld", "dev", project, "--port", String(process.env.CELLD_DEV_PORT ?? DEFAULT_ACTOR_PORT)], { env, stdout: "inherit", stderr: "inherit" })
const stop = () => { proxy.kill(); celld.kill() }
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
try {
  process.exitCode = await Promise.race([proxy.exited, celld.exited])
} finally {
  stop()
  await Promise.allSettled([proxy.exited, celld.exited])
}
