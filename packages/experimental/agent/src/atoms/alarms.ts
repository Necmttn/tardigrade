import { Schema } from "effect"
import { atom, durableAtom, eventValue } from "@clavia/tardigrade-experimental-core"
import { Alarm } from "@clavia/tardigrade-experimental-packages"
import type { Event, MessageReceived } from "../event"

const state = durableAtom({
  schema: Schema.Array(Schema.Struct({ alarm: Alarm, status: Schema.Literals(["pending", "cancelled", "rang"]) })),
  initial: [],
  reduce: (state, event: Event) => {
    if (event.type === "AlarmSet") {
      if (state.some(item => item.alarm.alarmId === event.alarm.alarmId)) throw new Error("Alarm identity already used")
      return [...state, { alarm: event.alarm, status: "pending" as const }]
    }
    if (event.type !== "AlarmCancelled" && event.type !== "AlarmRang") return state
    const pending = state.find(item => item.alarm.alarmId === event.alarmId && item.status === "pending")
    if (!pending) throw new Error("No matching pending alarm")
    return state.map(item => item === pending ? { ...item, status: event.type === "AlarmRang" ? "rang" as const : "cancelled" as const } : item)
  },
})

// alarms exposes the earliest pending deadline and recorded alarm inbox deliveries.
export const alarms = atom(get => {
  const items = get(state)
  const pending = items.filter(item => item.status === "pending").map(item => item.alarm)
  const next = pending.reduce<Alarm | undefined>((first, alarm) => !first || alarm.at < first.at ? alarm : first, undefined)
  const effects = Object.fromEntries(items.filter(item => item.status === "rang").map(({ alarm }) => [
    `alarm:${encodeURIComponent(alarm.alarmId)}`,
    eventValue({
      id: `deliver:${alarm.alarmId}`,
      event: {
        type: "MessageReceived",
        kind: "message",
        turnId: alarm.alarmId,
        text: `Alarm rang (data): ${JSON.stringify(alarm)}`,
      } satisfies MessageReceived,
    }),
  ]))
  return { pending, next, effects }
})
