import { DateTime, Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount, Subscription, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import {
  DEFAULTS,
  Event,
  Thread,
  demoEvents,
  demoThreads,
  fit,
  getJson,
  layout,
  matches,
  parseEvents,
  parseThreads,
  zoomAt
} from "./data"

const Camera = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  zoom: Schema.Finite
})
export const Model = Schema.Struct({
  source: Schema.Literals(["demo", "live"]),
  threads: Schema.Array(Thread),
  events: Schema.Array(Event),
  selected: Schema.String,
  query: Schema.String,
  jumpError: Schema.String,
  filter: Schema.String,
  camera: Camera,
  width: Schema.Finite,
  height: Schema.Finite,
  drag: Schema.NullOr(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
  loading: Schema.Boolean,
  eventLoading: Schema.Boolean,
  error: Schema.String,
  eventError: Schema.String,
  generation: Schema.Finite,
  refreshed: Schema.String,
  settings: Schema.Boolean,
  pollMs: Schema.Finite,
  eventLimit: Schema.Finite,
  requestMs: Schema.Finite,
  actor: Schema.String
})
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  Source: { source: Schema.Literals(["demo", "live"]) },
  Select: { id: Schema.String },
  Search: { query: Schema.String },
  Filter: { status: Schema.String },
  ClearFilters: {},
  Zoom: { factor: Schema.Finite, x: Schema.Finite, y: Schema.Finite },
  Fit: {},
  Focus: { id: Schema.String },
  Jump: {},
  DragStart: { x: Schema.Finite, y: Schema.Finite },
  DragMove: { x: Schema.Finite, y: Schema.Finite },
  DragEnd: {},
  Pan: { x: Schema.Finite, y: Schema.Finite },
  Resized: { width: Schema.Finite, height: Schema.Finite },
  Refresh: {},
  Settings: {},
  Setting: {
    key: Schema.Literals(["pollMs", "eventLimit", "requestMs", "actor"]),
    value: Schema.String
  },
  FleetLoaded: {
    generation: Schema.Finite,
    threads: Schema.Array(Thread),
    at: Schema.String
  },
  FleetFailed: { generation: Schema.Finite },
  EventsLoaded: {
    generation: Schema.Finite,
    id: Schema.String,
    events: Schema.Array(Event)
  },
  EventsFailed: { generation: Schema.Finite, id: Schema.String }
})
export type Message = typeof Message.Type
const LoadFleet = Command.define("LoadFleet", {
  args: {
    generation: Schema.Finite,
    actor: Schema.String,
    requestMs: Schema.Finite
  },
  messages: [Message.FleetLoaded, Message.FleetFailed],
  execute: ({ generation, actor, requestMs }) =>
    Effect.tryPromise(async (signal) =>
      parseThreads(
        await getJson(
          `/v1/actors/${encodeURIComponent(actor)}/threads`,
          requestMs,
          signal
        )
      )
    ).pipe(
      Effect.flatMap((threads) =>
        DateTime.now.pipe(
          Effect.map((at) =>
            Message.FleetLoaded({
              generation,
              threads,
              at: DateTime.formatIso(at)
            })
          )
        )
      ),
      Effect.orElseSucceed(() => Message.FleetFailed({ generation }))
    )
})
const LoadEvents = Command.define("LoadEvents", {
  args: {
    generation: Schema.Finite,
    actor: Schema.String,
    id: Schema.String,
    eventLimit: Schema.Finite,
    requestMs: Schema.Finite
  },
  messages: [Message.EventsLoaded, Message.EventsFailed],
  execute: ({ generation, actor, id, eventLimit, requestMs }) =>
    Effect.tryPromise(async (signal) =>
      parseEvents(
        await getJson(
          `/v1/actors/${encodeURIComponent(actor)}/threads/${encodeURIComponent(id)}/events?after=0&limit=${eventLimit}`,
          requestMs,
          signal
        )
      )
    ).pipe(
      Effect.map((events) => Message.EventsLoaded({ generation, id, events })),
      Effect.orElseSucceed(() => Message.EventsFailed({ generation, id }))
    )
})
export const initialModel: Model = {
  source: "demo",
  threads: demoThreads(DEFAULTS.demoThreads),
  events: [],
  selected: "",
  query: "",
  jumpError: "",
  filter: "all",
  camera: { x: 28, y: 20, zoom: 0.64 },
  width: 1000,
  height: 700,
  drag: null,
  loading: false,
  eventLoading: false,
  error: "",
  eventError: "",
  generation: 0,
  refreshed: "",
  settings: false,
  pollMs: DEFAULTS.pollMs,
  eventLimit: DEFAULTS.eventLimit,
  requestMs: DEFAULTS.requestMs,
  actor: DEFAULTS.actor
}
const fleet = (model: Model) =>
  LoadFleet({
    generation: model.generation,
    actor: model.actor,
    requestMs: model.requestMs
  })
const events = (model: Model) =>
  LoadEvents({
    generation: model.generation,
    actor: model.actor,
    id: model.selected,
    eventLimit: model.eventLimit,
    requestMs: model.requestMs
  })
export function update(
  model: Model,
  message: Message
): Update.Return<Model, Message> {
  switch (message._tag) {
    case "Source": {
      const next: Model = {
        ...model,
        source: message.source,
        threads:
          message.source === "demo" ? demoThreads(DEFAULTS.demoThreads) : [],
        selected: "",
        events: [],
        error: "",
        eventError: "",
        eventLoading: false,
        generation: model.generation + 1,
        loading: message.source === "live",
        query: "",
        filter: "all",
        refreshed: ""
      }
      return {
        model: { ...next, camera: initialModel.camera },
        commands: next.source === "live" ? [fleet(next)] : []
      }
    }
    case "Select": {
      const thread = model.threads.find((t) => t.id === message.id)
      const next = {
        ...model,
        selected: message.id,
        events: thread && model.source === "demo" ? demoEvents(thread) : [],
        eventError: "",
        eventLoading: model.source === "live"
      }
      return {
        model: next,
        commands: next.source === "live" && thread ? [events(next)] : []
      }
    }
    case "Search":
      return { model: { ...model, query: message.query, jumpError: "" } }
    case "ClearFilters":
      return { model: { ...model, query: "", filter: "all" } }
    case "Filter":
      return { model: { ...model, filter: message.status } }
    case "Zoom":
      return {
        model: {
          ...model,
          camera: zoomAt(model.camera, message.factor, message)
        }
      }
    case "Fit":
      return {
        model: {
          ...model,
          camera: fit(layout(model.threads), model.width, model.height)
        }
      }
    case "Jump": {
      const query = model.query.trim()
      const exact = model.threads.find((thread) => thread.id === query)
      const results = query
        ? model.threads.filter((thread) => matches(thread, query, model.filter))
        : []
      const target = exact ?? (results.length === 1 ? results[0] : undefined)
      return target
        ? update(model, Message.Focus({ id: target.id }))
        : {
            model: {
              ...model,
              jumpError:
                results.length > 1
                  ? "Select a thread from the results."
                  : "Enter a matching thread ID or name."
            }
          }
    }
    case "Focus": {
      const node = layout(model.threads).nodes.find((n) => n.id === message.id)
      if (!node) return { model }
      const result = update(model, Message.Select({ id: node.id }))
      return {
        ...result,
        model: {
          ...result.model,
          query: "",
          filter: "all",
          jumpError: "",
          drag: null,
          camera: {
            zoom: 1,
            x: model.width / 2 - node.x - 95,
            y: model.height / 2 - node.y - 24
          }
        }
      }
    }
    case "DragStart":
      return { model: { ...model, drag: { x: message.x, y: message.y } } }
    case "DragMove":
      return {
        model: model.drag
          ? {
              ...model,
              camera: {
                ...model.camera,
                x: model.camera.x + message.x - model.drag.x,
                y: model.camera.y + message.y - model.drag.y
              },
              drag: { x: message.x, y: message.y }
            }
          : model
      }
    case "Pan":
      return {
        model: {
          ...model,
          camera: {
            ...model.camera,
            x: model.camera.x + message.x,
            y: model.camera.y + message.y
          }
        }
      }
    case "DragEnd":
      return { model: { ...model, drag: null } }
    case "Resized":
      return {
        model: { ...model, width: message.width, height: message.height }
      }
    case "Settings":
      return { model: { ...model, settings: !model.settings } }
    case "Setting": {
      const value =
        message.key === "actor"
          ? message.value.trim() || DEFAULTS.actor
          : Number(message.value)
      if (
        typeof value === "number" &&
        (!Number.isSafeInteger(value) || value <= 0)
      )
        return { model }
      const next = {
        ...model,
        [message.key]: value,
        generation: model.generation + 1,
        loading: false,
        eventLoading: false,
        ...(message.key === "actor" && model.source === "live"
          ? { threads: [], events: [], selected: "", refreshed: "", error: "" }
          : {})
      }
      return { model: next }
    }
    case "Refresh": {
      if (model.source !== "live" || model.loading) return { model }
      const next = {
        ...model,
        loading: true,
        eventLoading: Boolean(model.selected)
      }
      return {
        model: next,
        commands: [fleet(next), ...(model.selected ? [events(next)] : [])]
      }
    }
    case "FleetLoaded": {
      if (model.source !== "live" || message.generation !== model.generation)
        return { model }
      return {
        model: {
          ...model,
          threads: message.threads,
          loading: false,
          error: "",
          refreshed: message.at,
          camera:
            model.threads.length === 0
              ? fit(layout(message.threads), model.width, model.height)
              : model.camera
        }
      }
    }
    case "FleetFailed":
      return {
        model:
          message.generation === model.generation && model.source === "live"
            ? {
                ...model,
                loading: false,
                error:
                  "Cannot read the server. Check the server address and actor. Previous records remain visible."
              }
            : model
      }
    case "EventsLoaded":
      return {
        model:
          message.generation === model.generation &&
          message.id === model.selected &&
          model.source === "live"
            ? {
                ...model,
                events: message.events,
                eventLoading: false,
                eventError: ""
              }
            : model
      }
    case "EventsFailed":
      return {
        model:
          message.generation === model.generation &&
          message.id === model.selected &&
          model.source === "live"
            ? {
                ...model,
                eventLoading: false,
                eventError: "Cannot read events for this thread."
              }
            : model
      }
  }
}
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  poll: entry(
    { source: Schema.String, pollMs: Schema.Finite },
    {
      modelToDependencies: (model) => ({
        source: model.source,
        pollMs: model.pollMs
      }),
      dependenciesToStream: ({ source, pollMs }) =>
        source === "live"
          ? Stream.tick(`${pollMs} millis`).pipe(
              Stream.map(() => Message.Refresh())
            )
          : Stream.empty
    }
  )
}))
export const ObserveCanvas = Mount.defineStream("ObserveCanvas", {
  messages: [Message.Resized, Message.Zoom],
  execute: ({ element }) =>
    Stream.callback<typeof Message.Resized.Type | typeof Message.Zoom.Type>(
      (queue) =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const resize = new ResizeObserver(([entry]) => {
                if (entry)
                  Queue.offerUnsafe(
                    queue,
                    Message.Resized({
                      width: entry.contentRect.width,
                      height: entry.contentRect.height
                    })
                  )
              })
              resize.observe(element)
              const wheel = (event: WheelEvent) => {
                event.preventDefault()
                const rect = element.getBoundingClientRect()
                Queue.offerUnsafe(
                  queue,
                  Message.Zoom({
                    factor: Math.exp(-event.deltaY * 0.002),
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top
                  })
                )
              }
              element.addEventListener("wheel", wheel as EventListener, {
                passive: false
              })
              return { resize, wheel }
            }),
            ({ resize, wheel }) =>
              Effect.sync(() => {
                resize.disconnect()
                element.removeEventListener("wheel", wheel as EventListener)
              })
          )
          return yield* Effect.never
        })
    )
})
export const pointer = (x: number, y: number) =>
  Option.some(Message.DragMove({ x, y }))
