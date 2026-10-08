import { Clock, Effect, Layer } from "effect"
import { actorContext } from "tardie/agent"
import { modelActs, modelInfo, liveModelServices, toolActs } from "tardie/agent/services"
import { createActorWorker } from "tardie/platform/cloudflare"
import { providerLayer } from "tardie/model/providers/openai"
import { ModelLock, lockedModelConfigOf, modelLockService, parseModelLock } from "tardie/model/lock"
import { modelCredentialsFrom } from "tardie/model/config"
import definition, { clock } from "../actor"
import modelLock from "./models.lock.json"

const definitions = parseModelLock(JSON.stringify(modelLock))
const model = definitions.models[0]!
const config = lockedModelConfigOf({ default: { provider: model.provider, model_id: model.model_id }, allow: [{ provider: model.provider, model_ids: [model.model_id] }], providers: modelLock.providers }, definitions)
const { providers: _providers, ...policy } = config
const lock = Layer.succeed(ModelLock, modelLockService(definitions, policy))
const clockTools = clock.implement({ now: () => Effect.map(Clock.currentTimeMillis, now => new Date(now).toISOString()) })

const worker = createActorWorker({
  actor: definition,
  actorContext,
  http: (env: { PROXY_API_KEY: string; TARDIGRADE_TOKEN: string }) => ({ token: env.TARDIGRADE_TOKEN }),
  services: env => Layer.mergeAll(modelInfo, modelActs, toolActs([clockTools])).pipe(Layer.provide(
    liveModelServices({ providerLayer, credentials: modelCredentialsFrom(config, env) }).pipe(Layer.provideMerge(lock))
  ))
})

export const ActorDO = worker.ActorObject
export const ThreadDO = worker.ThreadObject
export default { fetch: worker.fetch }
