import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { rewriteComponentRuntimeImports, rewriteWorkspaceImports, stageInitTemplates } from "./publish-paths"
import { publishDependencies, publishSources } from "./publish-manifest"
import { publicExports } from "./publish-exports"

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
    let source = rewriteWorkspaceImports(await readFile(path, "utf8"), path, sourceRoot, privatePackages)
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
const privatePackages = packages
  .filter(source => ["core", "agent", "libraries", "platform"].includes(source.namespace))
  .map(source => ({ name: source.pkg.name, namespace: source.namespace, exports: "exports" in source.pkg ? source.pkg.exports : {} }))
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

  const rewrites = new Map(packages
    .filter(source => source.namespace !== "tardie" && !privatePackages.some(pkg => pkg.name === source.pkg.name))
    .map(source => [source.pkg.name, `${publicSource.pkg.name}/${source.namespace}`] as const))
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
    exports: publicExports,
    ...dependencies
  }
  await writeFile(join(stage, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`)

  // The staged package must resolve its rewritten self-imports through the public export map.
  const stagedModules = join(stage, "node_modules")
  await symlink(join(root, "node_modules"), stagedModules, "dir")
  try {
    await run([process.execPath, "-e", "const root = await import('tardie'); const core = await import('tardie/core'); const agent = await import('tardie/agent'); const deprecated = await import('tardie/deprecated'); const oldCore = await import('tardie/deprecated/core'); if (root.defineActor !== core.defineActor || root.infer !== agent.infer || deprecated.defineActor !== oldCore.defineActor || typeof core.durableAtom !== 'function' || root.defineActor === deprecated.defineActor) throw new Error('public exports failed'); for (const name of ['tool', 'infer', 'code', 'permissions', 'budget', 'compaction', 'context', 'escalation', 'escalate', 'compact']) { const component = await import('tardie/deprecated/component/' + name); if (component !== await import('tardie/deprecated/agent/component/' + name)) throw new Error('component alias failed: ' + name) } const testing = await import('tardie/deprecated/testing'); const agentTesting = await import('tardie/deprecated/agent/testing'); if (typeof testing.checkActor !== 'function' || typeof testing.replayActor !== 'function' || typeof agentTesting.testInferenceLayer !== 'function') throw new Error('testing exports failed'); await import('tardie/core/runtime'); await import('tardie/core/services'); await import('tardie/agent/services'); await import('tardie/deprecated/platform/bun'); await import('tardie/bun'); await import('tardie/client'); for (const path of ['tardie/v1', 'tardie/v2', 'tardie/core/atoms/act', 'tardie/core/event-log', 'tardie/deprecated/core/component/runtime', 'tardie/deprecated/core/component/composition/parent']) { let blocked = false; try { await import(path) } catch { blocked = true } if (!blocked) throw new Error(path + ' is publicly importable') }"], stage)
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
