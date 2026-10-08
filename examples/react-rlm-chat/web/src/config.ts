export const DEFAULT_ACTOR_INSTANCE = "main"
export const DEFAULT_API_URL = "http://localhost:4242"

const configured = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().replace(/\/$/, "") : undefined

export const actorInstance = (value: unknown = import.meta.env.VITE_ACTOR_ID): string =>
  configured(value) ?? DEFAULT_ACTOR_INSTANCE

export const apiUrl = (value: unknown = import.meta.env.VITE_API_URL): string =>
  configured(value) ?? (typeof location === "undefined" ? DEFAULT_API_URL : location.origin)

export const DEFAULT_EVENT_POLL_MS = 0
export const eventPollMs = (value: unknown = import.meta.env.VITE_EVENT_POLL_MS): number | false => {
  const interval = Number(value ?? DEFAULT_EVENT_POLL_MS)
  if (!Number.isSafeInteger(interval) || interval < 0) throw new Error("VITE_EVENT_POLL_MS must be a non-negative integer")
  return interval === 0 ? false : interval
}
