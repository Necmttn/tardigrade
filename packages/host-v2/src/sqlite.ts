import { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import type { Journal } from "./journal"

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000

export interface SqliteJournalOptions<Event> {
  readonly path: string
  readonly stream: string
  readonly schema: Schema.ConstraintCodec<Event, unknown>
  readonly busyTimeoutMs?: number
}

function json(value: unknown): string {
  const ancestors = new Set<object>()
  const check = (current: unknown): void => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return
    if (typeof current === "number" && Number.isFinite(current)) return
    if (typeof current !== "object" || current === null) throw new Error("Journal codec must encode JSON values")
    if (ancestors.has(current)) throw new Error("Journal codec produced a cycle")
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new Error("Journal codec must encode plain JSON objects")
    }
    if (Object.getOwnPropertySymbols(current).length) throw new Error("Journal codec produced symbol keys")
    ancestors.add(current)
    if (Array.isArray(current)) {
      for (const item of current) check(item)
    } else {
      for (const item of Object.values(current)) check(item)
    }
    ancestors.delete(current)
  }
  check(value)
  return JSON.stringify(value)
}

// sqliteJournal opens an append-only stream and checks revisions inside immediate transactions.
// The caller owns close; the codec must synchronously encode and decode JSON-compatible values.
export function sqliteJournal<Event>(options: SqliteJournalOptions<Event>): Journal<Event> & { readonly close: () => void } {
  const timeout = options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) throw new Error("busyTimeoutMs must be an integer from 0 through 2147483647")
  if (!options.stream) throw new Error("A journal stream name is required")
  const database = new Database(options.path, { create: true, strict: true })
  try {
    database.exec(`PRAGMA busy_timeout = ${timeout}`)
    database.exec(`CREATE TABLE IF NOT EXISTS host_v2_events (
      stream TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      event_json TEXT NOT NULL,
      PRIMARY KEY (stream, revision)
    )`)
    const rows = database.query<{ revision: number; event_json: string }, [string]>(
      "SELECT revision, event_json FROM host_v2_events WHERE stream = ? ORDER BY revision",
    )
    const latest = database.query<{ revision: number }, [string]>(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM host_v2_events WHERE stream = ?",
    )
    const insert = database.query("INSERT INTO host_v2_events (stream, revision, event_json) VALUES (?, ?, ?)")
    const encode = Schema.encodeSync(options.schema, { onExcessProperty: "error" })
    const decode = Schema.decodeUnknownSync(options.schema, { onExcessProperty: "error" })
    const commit = database.transaction((expectedRevision: number, encoded: string) => {
      const revision = latest.get(options.stream)!.revision
      if (revision !== expectedRevision) throw new Error(`Journal conflict: expected ${expectedRevision}, found ${revision}`)
      insert.run(options.stream, revision + 1, encoded)
    })
    const failure = (error: unknown) => error instanceof Error ? error : new Error(String(error))
    return {
      read: () => Effect.try({
        try: () => rows.all(options.stream).map((row, index) => {
          if (row.revision !== index + 1) throw new Error(`Journal revision gap at ${index + 1}`)
          return decode(JSON.parse(row.event_json))
        }),
        catch: failure,
      }),
      append: (expectedRevision, event) => Effect.try({
        try: () => {
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) {
            throw new Error("Expected revision must be a nonnegative safe integer below Number.MAX_SAFE_INTEGER")
          }
          const encoded = json(encode(event))
          decode(JSON.parse(encoded))
          commit.immediate(expectedRevision, encoded)
        },
        catch: failure,
      }),
      close: () => database.close(),
    }
  } catch (error) {
    database.close()
    throw error
  }
}
