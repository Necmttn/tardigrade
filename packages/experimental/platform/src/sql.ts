import type { Journal, Recorded } from "@clavia/tardigrade-experimental-core"

export interface JournalSql {
  readonly rows: (query: string, ...bindings: readonly (string | number)[]) => readonly Record<string, unknown>[]
  readonly transaction: (commit: () => void) => void
  readonly flush: () => Promise<void>
}

// sqlJournal isolates event sequences by actor and rejects concurrent writers with a stale prefix.
export function sqlJournal<Event extends object>(sql: JournalSql, actor: string): Journal<Event> {
  if (!actor) throw new Error("Journal actor identity must be nonempty")
  sql.rows("CREATE TABLE IF NOT EXISTS experimental_events (actor TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (actor, seq)) WITHOUT ROWID")
  return {
    read: async () => sql.rows("SELECT seq, event FROM experimental_events WHERE actor = ? ORDER BY seq", actor).map((row, index) => {
      if (row.seq !== index || typeof row.event !== "string") throw new Error("Invalid journal sequence")
      return JSON.parse(row.event) as Recorded<Event>
    }),
    append: async (expectedLength, events) => {
      if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) throw new Error("Invalid expected journal length")
      const encoded = events.map(event => JSON.stringify(event))
      sql.transaction(() => {
        const count = sql.rows("SELECT COUNT(*) AS count FROM experimental_events WHERE actor = ?", actor)[0]?.count
        if (count !== expectedLength) throw new Error(`Journal conflict for ${actor}: expected ${expectedLength}, found ${String(count)}`)
        for (const [index, event] of encoded.entries()) {
          sql.rows("INSERT INTO experimental_events (actor, seq, event) VALUES (?, ?, ?)", actor, expectedLength + index, event)
        }
      })
      await sql.flush()
    },
  }
}
