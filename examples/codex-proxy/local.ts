import { Config, Crypto, Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { RuntimeError } from "tardie/core"
import modelLock from "./celld/models.lock.json"

export const DEFAULT_ACTOR_PORT = 9876
export const start = Effect.fn("start")(function* (directory: string) {
  if (modelLock.models[0]!.model_id === "YOUR_MODEL_ID") return yield* Effect.fail(new RuntimeError("Set your model and context window in celld/models.lock.json"))
  const fs = yield* FileSystem
  const path = yield* Path
  const crypto = yield* Crypto.Crypto
  const key = yield* crypto.randomUUIDv4
  const token = yield* crypto.randomUUIDv4
  const project = path.join(directory, "celld")
  const vars = path.join(project, ".dev.vars")
  yield* fs.writeFileString(vars, `PROXY_API_KEY=${key}\nTARDIGRADE_TOKEN=${token}\n`, { mode: 0o600 })
  yield* fs.chmod(vars, 0o600)
  const port = yield* Config.Int("CELLD_DEV_PORT").pipe(Config.withDefault(DEFAULT_ACTOR_PORT))
  const systemPath = yield* Config.String("PATH")
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("celld", ["dev", project, "--port", String(port)], {
    env: { PATH: `${path.resolve(directory, "../../node_modules/.bin")}:${systemPath}` }, extendEnv: true, stdout: "inherit", stderr: "inherit"
  }))
  return { key, child }
})
