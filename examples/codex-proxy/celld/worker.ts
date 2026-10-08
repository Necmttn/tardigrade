import { Layer } from "effect"
import { NativeOutputSupport } from "tardie/agent"
import { defineWorkerHost, workerHttp, workerModelServices, modelScopeFrom } from "@clavia/tardigrade-cloudflare/worker"
import { providerLayer } from "@clavia/tardigrade-model/providers/openai"
import definition from "../actor"
import modelLock from "./models.lock.json"

const host = defineWorkerHost(definition, {
  services: workerModelServices({ model: { providerLayer }, scope: modelScopeFrom(modelLock) }),
  layersFor: () => Layer.succeed(NativeOutputSupport, { withTools: true })
})

export const { ActorDO, ThreadDO } = host
export default workerHttp(host)
