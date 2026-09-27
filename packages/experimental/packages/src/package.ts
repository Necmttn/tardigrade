import type { AgentTool } from "./tool"

export interface Package<R = never> {
  readonly name: string
  readonly description: string
  readonly methods: readonly AgentTool<R>[]
}

// definePackage groups validated methods for direct tools and code execution.
export function definePackage<R>(definition: Package<R>): Package<R> {
  if (!/^[A-Za-z_$][\w$]*$/.test(definition.name)) throw new Error(`Invalid package name: ${definition.name}`)
  if (new Set(definition.methods.map(method => method.spec.name)).size !== definition.methods.length) throw new Error(`Duplicate method in ${definition.name}`)
  return definition
}

export type PackageRequirements<P> = P extends Package<infer R> ? R : never

// packageTools exposes package methods under qualified names.
export function packageTools<const P extends readonly Package<unknown>[]>(packages: P): readonly AgentTool<PackageRequirements<P[number]>>[] {
  if (new Set(packages.map(pkg => pkg.name)).size !== packages.length) throw new Error("Duplicate package name")
  const methods = packages.flatMap(pkg => pkg.methods.map(method => ({
    ...method,
    spec: { ...method.spec, name: `${pkg.name}__${method.spec.name}`, description: `${pkg.description}\n${method.spec.description}` },
  })))
  if (new Set(methods.map(method => method.spec.name)).size !== methods.length) throw new Error("Duplicate qualified method name")
  return methods as readonly AgentTool<PackageRequirements<P[number]>>[]
}
