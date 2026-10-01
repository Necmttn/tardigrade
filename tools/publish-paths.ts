import { cp, mkdir, rm } from "node:fs/promises"
import { INIT_TEMPLATES } from "../apps/deprecated/cli/src/template"
import { dirname, join, relative } from "node:path"

// rewriteComponentRuntimeImports preserves private relative imports when packages share a staged source root (publish-paths.test.ts).
export const rewriteComponentRuntimeImports = (source: string, file: string, sourceRoot: string): string => {
  const target = relative(dirname(file), join(sourceRoot, "deprecated/core/component/runtime"))
  return source.replace(/(["'])(?:\.\.\/)+core\/src\/component\/runtime\1/g,
    (_match, quote: string) => `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`)
}

interface StagedWorkspace {
  readonly name: string
  readonly namespace: string
  readonly exports: Readonly<Record<string, string | null>>
}

// rewriteWorkspaceImports resolves implementation imports through workspace declarations within the staged package.
export function rewriteWorkspaceImports(source: string, file: string, sourceRoot: string, packages: readonly StagedWorkspace[]): string {
  return source.replace(/(\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)(["'])([^"']+)\2/g, (match, prefix: string, quote: string, name: string) => {
    const pkg = packages.find(pkg => name === pkg.name || name.startsWith(`${pkg.name}/`))
    if (!pkg) return match
    const subpath = name === pkg.name ? "." : `.${name.slice(pkg.name.length)}`
    let target = pkg.exports[subpath]
    if (target === undefined) {
      const patterns = Object.keys(pkg.exports).filter(path => path.includes("*")).sort((left, right) => right.indexOf("*") - left.indexOf("*") || right.length - left.length)
      for (const pattern of patterns) {
        const [start, end] = pattern.split("*") as [string, string]
        if (!subpath.startsWith(start) || !subpath.endsWith(end)) continue
        const value = pkg.exports[pattern]
        const wildcard = subpath.slice(start.length, end.length === 0 ? undefined : -end.length)
        target = value?.replace("*", wildcard) ?? null
        break
      }
    }
    if (!target?.startsWith("./src/")) throw new Error(`Cannot stage workspace import ${name} in ${file}`)
    const path = relative(dirname(file), join(sourceRoot, pkg.namespace, target.slice("./src/".length))).replace(/\.ts$/, "")
    return `${prefix}${quote}${path.startsWith(".") ? path : `./${path}`}${quote}`
  })
}

// stageInitTemplates copies only actor sources into a clean template directory (publish-paths.test.ts).
export const stageInitTemplates = async (root: string, stage: string): Promise<void> => {
  const destination = join(stage, "examples")
  await rm(destination, { recursive: true, force: true })
  await Promise.all(INIT_TEMPLATES.map(async template => {
    const target = join(destination, template)
    await mkdir(target, { recursive: true })
    await cp(join(root, "examples", template, "actor.ts"), join(target, "actor.ts"))
  }))
}
