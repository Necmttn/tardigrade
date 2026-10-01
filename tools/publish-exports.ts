import legacyAgentManifest from "../packages/deprecated/agent/package.json"

const legacyComponentExports = Object.fromEntries(
  Object.entries(legacyAgentManifest.exports)
    .filter(([path]) => path.startsWith("./component/") && !path.includes("*"))
    .flatMap(([path, target]) => {
      const staged = target.replace("./src/", "./src/deprecated/agent/")
      return [[path, staged], [`./agent${path.slice(1)}`, staged]]
    }),
)

const legacyExports = {
  ...legacyComponentExports,
  ".": "./src/tardie/deprecated/index.ts",
  "./agent": "./src/deprecated/agent/index.ts",
  "./agent/*": "./src/deprecated/agent/*.ts",
  "./agent/testing/model": "./src/deprecated/agent/testing/model.ts",
  "./agent/testing": "./src/tardie/agent-testing.ts",
  "./core": "./src/deprecated/core/index.ts",
  "./core/testing": "./src/deprecated/core/testing/check.ts",
  "./testing": "./src/tardie/testing.ts",
  "./code": "./src/deprecated/code/index.ts",
  "./actor/*": "./src/deprecated/agent/actor/*.ts",
  "./component/*": "./src/deprecated/agent/component/*.ts",
  "./component/infer/*": "./src/deprecated/agent/component/infer/*.ts",
  "./log/*": "./src/deprecated/agent/log/*.ts",
  "./output/*": "./src/deprecated/agent/output/*.ts",
  "./packages/*": "./src/deprecated/agent/packages/*.ts",
  "./projection/*": "./src/deprecated/agent/projection/*.ts",
  "./runtime/*": "./src/deprecated/agent/runtime/*.ts",
  "./core/actor": "./src/deprecated/core/actor/index.ts",
  "./core/actor/*": "./src/deprecated/core/actor/*.ts",
  "./core/alarm": "./src/deprecated/core/alarm.ts",
  "./core/interaction": "./src/deprecated/core/interaction/index.ts",
  "./core/interaction/*": "./src/deprecated/core/interaction/*.ts",
  "./core/transport": "./src/deprecated/core/transport/index.ts",
  "./core/transport/*": "./src/deprecated/core/transport/*.ts",
  "./core/component": "./src/deprecated/core/component/index.ts",
  "./core/component/runtime": null,
  "./core/component/composition/parent": null,
  "./core/component/compose": "./src/deprecated/core/component/composition/siblings.ts",
  "./core/component/children": "./src/deprecated/core/component/composition/children.ts",
  "./core/component/reconciliation": "./src/deprecated/core/component/composition/reconciliation.ts",
  "./core/component/tree": "./src/deprecated/core/component/composition/tree.ts",
  "./core/component/*": "./src/deprecated/core/component/*.ts",
  "./core/effect": "./src/deprecated/core/effect.ts",
  "./core/event": "./src/deprecated/core/event.ts",
  "./core/intent": "./src/deprecated/core/intent.ts",
  "./core/log": "./src/deprecated/core/log/index.ts",
  "./core/log/event": "./src/deprecated/core/event.ts",
  "./core/log/*": "./src/deprecated/core/log/*.ts",
  "./core/machine": "./src/deprecated/core/machine.ts",
  "./core/projection": "./src/deprecated/core/projection/projection.ts",
  "./core/projection/*": "./src/deprecated/core/projection/*.ts",
  "./core/reconciliation": "./src/deprecated/core/compatibility/reconciliation.ts",
  "./core/reconciliation/reconciler": "./src/deprecated/core/compatibility/reconciler.ts",
  "./core/reconciliation/transition": "./src/deprecated/core/compatibility/transition.ts",
  "./core/runtime": "./src/deprecated/core/runtime/index.ts",
  "./core/runtime/*": "./src/deprecated/core/runtime/*.ts",
  "./core/transition": "./src/deprecated/core/transition/index.ts",
  "./core/transition/*": "./src/deprecated/core/transition/*.ts",
  "./core/view": "./src/deprecated/core/view.ts",
  "./code/execution/*": "./src/deprecated/code/execution/*.ts",
  "./code/package/*": "./src/deprecated/code/package/*.ts",
  "./code/sandbox/*": "./src/deprecated/code/sandbox/*.ts",
  "./code/storage/*": "./src/deprecated/code/storage/*.ts",
  "./host/*": "./src/deprecated/host/*.ts",
  "./bun": "./src/deprecated/platform/bun/index.ts",
  "./bun/*": "./src/deprecated/platform/bun/*.ts",
  "./worker": "./src/deprecated/platform/cloudflare/index.ts",
  "./worker/*": "./src/deprecated/platform/cloudflare/*.ts",
  "./cloudflare": "./src/deprecated/platform/cloudflare/index.ts",
  "./cloudflare/*": "./src/deprecated/platform/cloudflare/*.ts",
  "./cli/*": "./src/deprecated/cli/*.ts",
  "./worker-loader/*": "./src/platform/shared/worker-loader/*.ts",
  "./channels": "./src/channels/index.ts",
  "./channels/*": "./src/channels/*.ts",
  "./client": "./src/client/index.ts",
  "./client/*": "./src/client/*.ts",
  "./http/*": "./src/http/*.ts",
  "./server/*": "./src/server/*.ts",
  "./model": "./src/model/index.ts",
  "./model/catalog": "./src/model/catalog/index.ts",
  "./model/catalog-store": "./src/model/catalog/repository.ts",
  "./model/catalog-page": "./src/model/catalog/page.ts",
  "./model/catalog-availability": "./src/model/catalog/availability.ts",
  "./model/metadata": "./src/model/catalog/metadata.ts",
  "./model/directory": "./src/model/providers/directory.ts",
  "./model/reasoning": "./src/model/providers/options.ts",
  "./model/request-policy": "./src/model/stream/policy.ts",
  "./model/output": "./src/model/output.ts",
  "./model/*": "./src/model/*.ts"
}

const sharedExports = Object.fromEntries(Object.entries(legacyExports).filter(([path]) =>
  ["model", "client", "channels", "http", "server"].some(name => path === `./${name}` || path.startsWith(`./${name}/`)),
))

const deprecatedExports = Object.fromEntries(Object.entries(legacyExports).map(([path, target]) => {
  const name = path === "." ? "./deprecated" : /^\.\/(bun|cloudflare)(?:\/|$)/.test(path)
    ? `./deprecated/platform/${path.slice(2)}` : `./deprecated/${path.slice(2)}`
  return [name, target]
}))

export const publicExports = {
  ".": "./src/tardie/index.ts",
  "./core": "./src/tardie/core.ts",
  "./core/runtime": "./src/tardie/core/runtime.ts",
  "./core/services": "./src/tardie/core/services.ts",
  "./agent": "./src/tardie/agent.ts",
  "./agent/services": "./src/tardie/agent/services.ts",
  "./libraries": "./src/tardie/libraries.ts",
  "./bun": "./src/platform/bun/index.ts",
  "./cloudflare": "./src/platform/cloudflare/index.ts",
  "./worker-loader": "./src/platform/shared/worker-loader/sandbox.ts",
  ...sharedExports,
  ...deprecatedExports,
  "./package.json": "./package.json",
}
