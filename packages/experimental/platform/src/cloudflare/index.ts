import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { sqlJournal } from "../sql"

// cloudflareJournal commits to a Durable Object SQLite database and flushes before acknowledging an append.
export function cloudflareJournal<Event extends object>(storage: DurableObjectStorage, actor: string) {
  return sqlJournal<Event>({
    rows: (query, ...bindings) => [...storage.sql.exec(query, ...bindings)],
    transaction: commit => storage.transactionSync(commit),
    flush: () => storage.sync(),
  }, actor)
}
