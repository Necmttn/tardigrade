import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Layer, Schema } from "effect"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ThreadCoordinate } from "@clavia/tardigrade-experimental-core"
import { liveModelServices } from "@clavia/tardigrade-experimental-agent/services/model"
import { memoryWorkspace } from "@clavia/tardigrade-experimental-packages"
import { ModelLock, lockedModelConfigOf, modelLockService, parseModelLock, MODEL_LOCK_FILE } from "@clavia/tardigrade-model/lock"
import { modelCredentialsFrom } from "@clavia/tardigrade-model/config"

const Config = Schema.Struct({ vars: Schema.Struct({ TARDIGRADE_CONFIG: Schema.Struct({ models: Schema.Unknown }) }) })

const env = { ...process.env }
const services = Layer.unwrap(Effect.gen(function* () {
  const configPath = resolve(env.TARDIGRADE_CONFIG_PATH?.trim() || fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)))
  const lockPath = join(dirname(configPath), MODEL_LOCK_FILE)
  const [configText, lockText] = yield* Effect.tryPromise({
    try: async () => {
      if (!await Bun.file(configPath).exists()) throw new RuntimeError(`Model configuration does not exist: ${configPath}`)
      if (!await Bun.file(lockPath).exists()) throw new RuntimeError(`Model lock is missing: ${lockPath}. Run tdg models lock from ${dirname(configPath)}.`)
      return Promise.all([Bun.file(configPath).text(), Bun.file(lockPath).text()])
    },
    catch: RuntimeError.from,
  })
  const raw = yield* Effect.try({ try: () => Bun.JSONC.parse(configText), catch: RuntimeError.from })
  const manifest = yield* Schema.decodeUnknownEffect(Config)(raw)
  return yield* Effect.try({
    try: () => {
      const definitions = parseModelLock(lockText, lockPath)
      const config = lockedModelConfigOf(manifest.vars.TARDIGRADE_CONFIG.models, definitions)
      const { providers: _providers, ...policy } = config
      const lock = Layer.succeed(ModelLock, modelLockService(definitions, policy))
      return Layer.merge(
        liveModelServices({ credentials: modelCredentialsFrom(config, env) }).pipe(Layer.provideMerge(lock)),
        memoryWorkspace,
      )
    },
    catch: RuntimeError.from,
  })
}))

export const layersFor = (_coordinate: ThreadCoordinate) => services
