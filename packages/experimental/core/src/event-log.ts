import { Context, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { atom, type Atom } from "./atom"
import { EventLog } from "./durable"
import { createStore } from "./store"
import { EffectRecord, effectKey, isEffectValue, type EffectRef, type Recorded, type IdentifiedEffectValue, type Proposed, type FailureOf, type ServicesOf } from "./internal/effects"

type Values<Atoms> = { readonly [Key in keyof Atoms]: Atoms[Key] extends Atom<infer Value> ? Value : never }

// createEventLog replays validated domain events and derives identified effect descriptions without executing them.
export function createEventLog<Event extends object, const Atoms extends Readonly<Record<string, Atom<unknown>>>>(options: {
  readonly schema: Schema.Schema<Event>
  readonly atoms: Atoms
}) {
  type EffectValues = Proposed<Values<Atoms>[keyof Atoms]>
  type Work = IdentifiedEffectValue<Recorded<Event>, FailureOf<EffectValues>, ServicesOf<EffectValues>>
  const validate = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const freeze = <Value>(value: Value): Value => {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Domain events must be plain data")
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }
  const eventOf = (record: unknown) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error("Domain event must be an object")
    const { effect, ...event } = record as Record<string, unknown>
    const domain = freeze(structuredClone(validate(event)))
    const metadata = effect === undefined ? undefined : freeze(Schema.decodeUnknownSync(EffectRecord)(effect))
    return { domain, record: metadata ? { ...domain, effect: metadata } : domain, metadata }
  }
  const replay = (history: readonly Recorded<Event>[]) => {
    const source = atom<readonly unknown[]>([])
    const store = createStore(Context.make(EventLog, { events: source }))
    const records: Recorded<Event>[] = []
    const domain: Event[] = []
    const references = new Map<string, EffectRef>()
    const declarations = new Map<string, Event | undefined>()
    const completed = new Map<string, Recorded<Event>>()
    const requested = new Map<string, Recorded<Event>>()
    const view = (): Values<Atoms> => Object.fromEntries(Object.entries(options.atoms).map(([name, node]) => [name, store.get(node)])) as Values<Atoms>
    const effects = (): readonly Work[] => {
      const values = view()
      const candidates = Object.entries(values).flatMap(([name, value]): [string, unknown][] => {
        if (typeof value !== "object" || value === null) return []
        if ("kind" in value && value.kind === "effect") return [[name, value]]
        const entries: [string, unknown][] = []
        if ("effect" in value && value.effect !== undefined) entries.push([name, value.effect])
        if ("effects" in value && value.effects !== undefined) {
          if (typeof value.effects !== "object" || value.effects === null || Array.isArray(value.effects)) throw new Error(`Invalid effect collection from ${name}`)
          for (const [source, effect] of Object.entries(value.effects)) {
            if (!source || source.includes("/")) throw new Error(`Invalid effect source: ${source}`)
            if (effect !== undefined) entries.push([`${name}/${source}`, effect])
          }
        }
        return entries
      })
      return candidates.flatMap(([name, candidate]) => {
        if (!isEffectValue(candidate)) throw new Error(`Invalid effect value from ${name}`)
        const proposal = candidate
        const key = JSON.stringify([name, proposal.id])
        const ref = references.get(key) ?? freeze({ seq: records.length, atom: name, tag: proposal.id })
        references.set(key, ref)
        const request = proposal.request === undefined ? undefined : eventOf(proposal.request)
        if (request?.metadata) throw new Error("Atoms must propose domain events without runtime metadata")
        const declared = declarations.get(effectKey(ref))
        if (declarations.has(effectKey(ref)) && !isDeepStrictEqual(declared, request?.domain)) throw new Error("Effect identity reused with a different request")
        declarations.set(effectKey(ref), request?.domain)
        if (completed.has(effectKey(ref))) return []
        const prior = requested.get(effectKey(ref))
        if (prior) {
          if (!isDeepStrictEqual(eventOf(prior).domain, request?.domain)) throw new Error("Effect identity reused with a different request")
          return []
        }
        return [{ ...proposal, ...(request ? { request: request.domain } : {}), ref, tag: proposal.id } as Work]
      })
    }
    effects()
    for (const raw of history) {
      const { domain: event, record, metadata } = eventOf(raw)
      if (metadata) {
        const known = references.get(JSON.stringify([metadata.ref.atom, metadata.ref.tag]))
        if (!known || effectKey(known) !== effectKey(metadata.ref)) throw new Error("Unknown effect reference")
        const key = effectKey(known)
        if (metadata.phase === "requested" && !isDeepStrictEqual(declarations.get(key), event)) throw new Error("Recorded request differs from its proposal")
        const ledger = metadata.phase === "settled" ? completed : requested
        const prior = ledger.get(key)
        if (prior) {
          if (!isDeepStrictEqual(prior, record)) throw new Error("Conflicting effect delivery")
          throw new Error("Duplicate effect delivery in replay history")
        }
        ledger.set(key, record)
      }
      records.push(freeze(record))
      domain.push(event)
      store.set(source, Object.freeze([...domain]))
      effects()
    }
    return Object.freeze({
      events: Object.freeze(records),
      get: store.get,
      view,
      effects,
      pending: () => [...requested].filter(([key]) => !completed.has(key)).map(([, record]) => record),
    })
  }
  type Snapshot = ReturnType<typeof replay>
  return {
    initial: replay([]),
    replay,
    append: (snapshot: Snapshot, event: Recorded<Event>): Snapshot => {
      const { record, metadata } = eventOf(event)
      if (metadata) {
        const prior = snapshot.events.find(item => item.effect?.phase === metadata.phase && effectKey(item.effect.ref) === effectKey(metadata.ref))
        if (prior) {
          if (!isDeepStrictEqual(prior, record)) throw new Error("Conflicting effect delivery")
          return snapshot
        }
      }
      return replay([...snapshot.events, record])
    },
    get: <Value>(snapshot: Snapshot, node: Atom<Value>): Value => snapshot.get(node),
    view: (snapshot: Snapshot) => snapshot.view(),
    effects: (snapshot: Snapshot) => snapshot.effects(),
  }
}
