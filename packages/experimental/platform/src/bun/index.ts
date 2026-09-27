import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { createThreadHost, type ThreadStorage } from "@clavia/tardigrade-experimental-core"
import { sqlJournal } from "../sql"
export { serve, DEFAULT_SERVE_OPTIONS, type ServeOptions } from "./serve"

// bunJournal opens a SQLite event journal; its caller closes it after closing the actor.
export function bunJournal<Event extends object>(options: { readonly filename: string; readonly actor: string }) {
  const database = new Database(options.filename, { create: true, strict: true })
  try {
    const journal = sqlJournal<Event>({
      rows: (query, ...bindings) => database.query<Record<string, unknown>, (string | number)[]>(query).all(...bindings),
      transaction: commit => database.transaction(commit).immediate(),
      flush: async () => {},
    }, options.actor)
    return { ...journal, close: () => database.close() }
  } catch (error) {
    database.close()
    throw error
  }
}

// createBunHost keeps an instance supervisor database and separate thread databases beneath storage.
export async function createBunHost<Event extends object, Services, Methods extends Readonly<Record<string, (...args: never[]) => Promise<void>>>, State>(options: Omit<Parameters<typeof createThreadHost<Event, Services, Methods, State>>[0], "storage"> & { readonly storage: string }) {
  const connections = new Set<() => void>()
  const encoded = (value: string) => Buffer.from(value).toString("base64url")
  const instanceFile = (actor: string, instance: string) => join(options.storage, `${encoded(JSON.stringify([actor, instance]))}.sqlite`)
  const journal = <Entry extends object>(filename: string, actor: string) => {
    mkdirSync(dirname(filename), { recursive: true })
    const opened = bunJournal<Entry>({ filename, actor })
    connections.add(opened.close)
    return opened
  }
  const storage: ThreadStorage<Event> = {
    supervisor: (actor, instance) => journal(instanceFile(actor, instance), "supervisor"),
    thread: coordinate => journal(join(`${instanceFile(coordinate.actor, coordinate.instance)}.threads`, `${encoded(coordinate.thread)}.sqlite`), "events"),
    invocations: coordinate => journal(join(`${instanceFile(coordinate.actor, coordinate.instance)}.threads`, `${encoded(coordinate.thread)}.sqlite`), "invocations"),
    close: async () => {
      const failures: unknown[] = []
      for (const close of connections) { try { close() } catch (error) { failures.push(error) } }
      connections.clear()
      if (failures.length) throw new AggregateError(failures, "Closing Bun journals failed")
    },
  }
  return createThreadHost({ ...options, storage })
}
