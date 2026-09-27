import { Schema } from "effect"
import { atom, durableAtom, eventValue } from "@clavia/tardigrade-experimental-core"
import { TaskRequest, TaskDecision } from "@clavia/tardigrade-experimental-packages"
import type { Event, MessageReceived } from "../event"
import { TasksState, tasksState } from "../projections"

const state = durableAtom({ schema: TasksState, initial: [], reduce: tasksState })

const exchanges = durableAtom({
  schema: Schema.Array(Schema.Struct({ taskId: Schema.String, request: TaskRequest, decision: Schema.NullOr(TaskDecision) })),
  initial: [],
  reduce: (state, event: Event) => {
    if (event.type === "MessageReceived" && event.kind === "request") {
      if (state.some(item => item.taskId === event.taskId && item.request.requestId === event.request.requestId)) throw new Error("Duplicate task request")
      return [...state, { taskId: event.taskId, request: event.request, decision: null }]
    }
    if (event.type === "MessageReceived" && event.kind === "reply") {
      const pending = state.find(item => item.taskId === event.taskId && item.request.requestId === event.requestId && item.decision === null)
      if (!pending) throw new Error("No matching pending task request")
      return state.map(item => item === pending ? { ...item, decision: event.decision } : item)
    }
    return state
  },
})

// tasks correlates request messages and proposes inbox deliveries for task settlements.
export const tasks = atom(get => {
  const items = get(state)
  const requests = get(exchanges)
  const deliveries = Object.fromEntries(items.filter(task => task.position === "settled").map(task => [
    `task:${encodeURIComponent(task.taskId)}`,
    eventValue({
      id: `deliver:${task.taskId}`,
      event: {
        type: "MessageReceived",
        kind: "message",
        turnId: task.taskId,
        text: `Background task result (data): ${JSON.stringify({ taskId: task.taskId, output: task.output, error: task.error })}`,
      } satisfies MessageReceived,
    }),
  ]))
  return { items, requests, effects: deliveries }
})
