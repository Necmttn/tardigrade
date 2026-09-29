import type { Schema } from "effect"

// pureData copies and freezes JSON data, rejecting hidden runtime state (transition/event-intent.test.ts).
export function pureData(value: unknown): Schema.Json {
  const ancestors = new Set<object>()
  const visit = (value: unknown): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return
    if (typeof value !== "object" || value === null) throw new Error("State must contain only JSON data")
    if (ancestors.has(value)) throw new Error("State must not contain cycles")
    const array = Array.isArray(value)
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error("State must contain plain objects")
    ancestors.add(value)
    const keys = Reflect.ownKeys(value)
    if (array && keys.length !== value.length + 1) throw new Error("State must contain dense arrays")
    for (const key of keys) {
      if (array && key === "length") continue
      if (typeof key !== "string") throw new Error("State must not contain symbol keys")
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new Error("State must contain plain arrays")
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("State must not contain hidden fields or accessors")
      visit(descriptor.value)
    }
    ancestors.delete(value)
  }
  visit(value)
  const freeze = (value: Schema.Json): Schema.Json => {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
    return value
  }
  return freeze(JSON.parse(JSON.stringify(value)))
}
