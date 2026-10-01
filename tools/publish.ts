import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { rewriteComponentRuntimeImports, stageInitTemplates } from "./publish-paths"
import { publishDependencies, publishSources } from "./publish-manifest"

type PkgJson = {
  readonly name: string
  readonly version: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly [key: string]: unknown
}

const root = fileURLToPath(new URL("../", import.meta.url))
const dryRun = process.argv.includes("--dry-run")
const packOnly = process.argv.includes("--pack-only")
export const DEFAULT_STABLE_NPM_TAG = "latest"
export const DEFAULT_PRERELEASE_NPM_TAG = "next"

const option = (name: string) => {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

// The command the package installs, and the module it points at. One install gives the library, the
// server, the UI, and the command (sdk-and-cli-spec.md, "Phase 3").
const BIN_NAME = "tdg"

const BIN_ENTRY = "./src/cli/main.ts"

const legacyExports = {
  ".": "./src/tardie/index.ts",
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

const modernExports = {
  ".": "./src/tardie/v2/index.ts",
  "./core": "./src/core/index.ts",
  "./core/*": "./src/core/*.ts",
  "./core/actor": "./src/core/actor/definition.ts",
  "./core/event-log": "./src/core/runtime/replay.ts",
  "./agent": "./src/agent/index.ts",
  "./agent/*": "./src/agent/*.ts",
  "./agent/atoms": "./src/agent/atoms/index.ts",
  "./agent/atoms/durable": "./src/agent/atoms/durable/index.ts",
  "./agent/services": "./src/agent/services/index.ts",
  "./libraries": "./src/libraries/index.ts",
  "./libraries/*": "./src/libraries/*.ts",
  "./bun": "./src/platform/bun/index.ts",
  "./cloudflare": "./src/platform/cloudflare/index.ts",
  "./platform/*": "./src/platform/*.ts",
  "./platform/worker-loader/*": "./src/platform/shared/worker-loader/*.ts",
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
  "./model/*": "./src/model/*.ts",
  "./cli/*": "./src/cli/*.ts"
}

const versionedExports = (generation: string, exports: Readonly<Record<string, string | null>>) => Object.fromEntries(
  Object.entries(exports).map(([path, target]) => [path === "." ? `./${generation}` : `./${generation}/${path.slice(2)}`, target]),
)

const STAGED_EXAMPLES = "examples"


const npmMin = { maj: 11, min: 5, patch: 1 } as const

const readPkg = async (dir: string): Promise<PkgJson> => {
  const raw: unknown = await Bun.file(join(root, dir, "package.json")).json()
  if (typeof raw !== "object" || raw === null) throw new Error(`${dir}/package.json is not an object`)
  if (!("name" in raw) || !("version" in raw)) throw new Error(`${dir}/package.json is missing name or version`)
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error(`${dir}/package.json is missing name or version`)
  }
  return raw as PkgJson
}

const output = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}\n${stderr}`)
  return stdout.trim()
}

const run = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`)
}

const verifyPackedManifest = async (tarball: string, expected: {
  readonly dependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly peerDependenciesMeta: Readonly<Record<string, { readonly optional?: boolean }>>
}) => {
  const packed = JSON.parse(await output(["tar", "-xOf", tarball, "package/package.json"], root)) as {
    readonly dependencies?: Readonly<Record<string, string>>
    readonly peerDependencies?: Readonly<Record<string, string>>
    readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  }
  for (const [name, expectedDependencies] of [["dependencies", expected.dependencies], ["peerDependencies", expected.peerDependencies], ["peerDependenciesMeta", expected.peerDependenciesMeta]] as const) {
    if (JSON.stringify(packed[name] ?? {}) !== JSON.stringify(expectedDependencies)) {
      throw new Error(`packed manifest ${name} differs from the publication manifest`)
    }
  }
}

const parseNpm = (version: string) => {
  const [maj, min, patch] = version.trim().split(".").map((part) => Number(part))
  if (maj === undefined || min === undefined || patch === undefined || [maj, min, patch].some((part) => !Number.isFinite(part))) {
    throw new Error(`unreadable npm version: ${version}`)
  }
  return { maj, min, patch }
}

const npmAtLeast = (version: string, min: typeof npmMin) => {
  const found = parseNpm(version)
  if (found.maj !== min.maj) return found.maj > min.maj
  if (found.min !== min.min) return found.min > min.min
  return found.patch >= min.patch
}

const published = async (name: string, version: string) => {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
  const response = await fetch(url, { headers: { accept: "application/json" } })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`registry ${url} -> ${response.status}`)
  return true
}

const rewriteSources = async (dir: string, rewrites: ReadonlyMap<string, string>, sourceRoot = dir): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await rewriteSources(path, rewrites, sourceRoot)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
    let source = await readFile(path, "utf8")
    for (const [from, to] of rewrites) {
      source = source.replaceAll(`${from}/`, `${to}/`).replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`)
    }
    source = source.replace(/(["'])tardie\/experimental\/internal\/([^"']+)\1/g, (_match, quote: string, module: string) => {
      const target = relative(dirname(path), join(sourceRoot, "experimental/internal", module))
      return `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`
    })
    await writeFile(path, rewriteComponentRuntimeImports(source, path, sourceRoot))
  }
}

const packages = publishSources
const publicSource = packages.find((source) => source.namespace === "tardie")!
const dependencies = publishDependencies(packages.map((source) => source.pkg))
const version = option("--version") ?? (await readPkg(".")).version
const sourceTree = option("--source-tree")
const prerelease = version.includes("-")
const distTag = option("--tag") ?? (prerelease ? DEFAULT_PRERELEASE_NPM_TAG : DEFAULT_STABLE_NPM_TAG)
if (prerelease && distTag === DEFAULT_STABLE_NPM_TAG) {
  throw new Error(`prerelease ${version} cannot use npm tag ${DEFAULT_STABLE_NPM_TAG}`)
}

const releaseTag = process.env.GITHUB_REF?.startsWith("refs/tags/v") ? process.env.GITHUB_REF.slice("refs/tags/v".length) : undefined
if (releaseTag !== undefined && releaseTag !== version) {
  throw new Error(`tag v${releaseTag} does not match package version ${version}`)
}

if (process.env.GITHUB_ACTIONS === "true" && !dryRun && !packOnly) {
  const npmVersion = await output(["npm", "--version"], root)
  if (!npmAtLeast(npmVersion, npmMin)) {
    throw new Error(`trusted publishing needs npm >= ${npmMin.maj}.${npmMin.min}.${npmMin.patch}; this runner has ${npmVersion}`)
  }
}

const alreadyPublished = packOnly ? false : await published(publicSource.pkg.name, version)
if (!packOnly && !dryRun && alreadyPublished) {
  console.log(`skip ${publicSource.pkg.name}@${version} (already on the registry)`)
  process.exit(0)
}

const requestedOutput = option("--output")
const destination = requestedOutput === undefined ? await mkdtemp(join(tmpdir(), "tardigrade-pack-")) : resolve(root, requestedOutput)
const temporary = requestedOutput === undefined
const stage = join(destination, "package")

try {
  await mkdir(stage, { recursive: true })
  for (const source of packages) await mkdir(join(stage, "src", source.namespace), { recursive: true })
  await Promise.all([
    cp(join(root, "LICENSE"), join(stage, "LICENSE")),
    cp(join(root, "README.md"), join(stage, "README.md")),
    stageInitTemplates(root, stage),
    ...packages.map(async (source) => {
      await cp(join(root, source.dir, "src"), join(stage, "src", source.namespace), {
        recursive: true,
        filter: (path) => !path.endsWith(".test.ts") && path !== join(root, "packages/model/src/testing")
      })
    })
  ])

  const rewrites = new Map([
    ["@clavia/tardigrade-platform/bun", "tardie/v2/bun"],
    ["@clavia/tardigrade-platform/cloudflare", "tardie/v2/cloudflare"],
    ...packages
      .filter((source) => source.namespace !== "tardie")
      .map((source) => {
        const namespace = source.namespace.startsWith("deprecated/")
          ? source.namespace.replace("deprecated/platform/", "v1/").replace("deprecated/", "v1/")
          : ["core", "agent", "libraries", "platform", "cli"].includes(source.namespace) ? `v2/${source.namespace}` : source.namespace
        return [source.pkg.name, `${publicSource.pkg.name}/${namespace}`] as const
      })
  ])
  await rewriteSources(join(stage, "src"), rewrites)

  const repository = publicSource.pkg.repository
  const publishManifest = {
    name: publicSource.pkg.name,
    version,
    license: publicSource.pkg.license,
    author: publicSource.pkg.author,
    description: publicSource.pkg.description,
    homepage: publicSource.pkg.homepage,
    repository:
      typeof repository === "object" && repository !== null && "type" in repository && "url" in repository
        ? { type: repository.type, url: repository.url }
        : repository,
    bugs: publicSource.pkg.bugs,
    publishConfig: publicSource.pkg.publishConfig,
    ...(sourceTree === undefined ? {} : { tardigrade: { sourceTree } }),
    files: ["src", STAGED_EXAMPLES],
    engines: publicSource.pkg.engines,
    type: "module",
    bin: { [BIN_NAME]: BIN_ENTRY },
    exports: {
      ...legacyExports,
      "./deprecated": legacyExports["."],
      "./deprecated/platform/bun": legacyExports["./bun"],
      "./deprecated/platform/cloudflare": legacyExports["./cloudflare"],
      ...versionedExports("v1", legacyExports),
      ...versionedExports("v2", modernExports),
      "./package.json": "./package.json",
    },
    ...dependencies
  }
  await writeFile(join(stage, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`)

  // The staged package must resolve its rewritten self-imports through the public export map.
  const stagedModules = join(stage, "node_modules")
  await symlink(join(root, "node_modules"), stagedModules, "dir")
  try {
    await run([process.execPath, "-e", "const root = await import('tardie'); const v1 = await import('tardie/v1'); const v2 = await import('tardie/v2'); const core = await import('tardie/core'); const agent = await import('tardie/agent'); const atomCore = await import('tardie/v2/core'); const atomAgent = await import('tardie/v2/agent'); if (root.defineActor !== v1.defineActor || root.defineActor !== core.defineActor || root.infer !== agent.infer || v2.defineActor !== atomCore.defineActor || v2.infer !== atomAgent.infer || typeof atomCore.durableAtom !== 'function' || root.defineActor === v2.defineActor) throw new Error('generation exports failed'); const testing = await import('tardie/testing'); const agentTesting = await import('tardie/v1/agent/testing'); if (typeof testing.checkActor !== 'function' || typeof testing.replayActor !== 'function' || typeof agentTesting.testInferenceLayer !== 'function') throw new Error('testing exports failed'); const eventLog = await import('tardie/v2/core/event-log'); if (typeof eventLog.createEventLog !== 'function') throw new Error('event-log export failed'); await import('tardie/bun'); await import('tardie/v2/bun'); await import('tardie/client'); for (const prefix of ['tardie', 'tardie/v1']) for (const suffix of ['/core/component/runtime', '/core/component/composition/parent']) { let blocked = false; try { await import(prefix + suffix) } catch { blocked = true } if (!blocked) throw new Error(prefix + suffix + ' is publicly importable') }"], stage)
  } finally {
    await rm(stagedModules)
  }

  const filename = await output(["bun", "pm", "pack", "--destination", destination, "--quiet", "--ignore-scripts"], stage)
  const tarball = isAbsolute(filename) ? filename : join(destination, filename)
  await verifyPackedManifest(tarball, dependencies)
  if (packOnly) {
    console.log(`pack ${publicSource.pkg.name}@${version}`)
  } else {
    const publish = ["npm", "publish", tarball, "--access", "public", "--tag", distTag, ...(dryRun ? ["--dry-run"] : [])]
    console.log(`${dryRun ? "dry-run" : "publish"} ${publicSource.pkg.name}@${version} with npm tag ${distTag}`)
    if (dryRun && alreadyPublished) {
      console.log(`skip npm dry-run validation (version already on the registry)`)
    } else {
      await run(publish, root)
    }
  }
  if (requestedOutput !== undefined) console.log(`tarball ${tarball}`)
} finally {
  if (temporary) await rm(destination, { recursive: true, force: true })
}
