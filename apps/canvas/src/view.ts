import { activityView } from "./activity-view"
import { Option } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { layout, matches, type Status } from "./data"
import { Message, ObserveCanvas, pointer, type Model } from "./main"

const statuses: Status[] = [
  "running",
  "waiting",
  "failed",
  "settled",
  "unknown"
]
const labels: Record<Status, string> = {
  running: "Running",
  waiting: "Waiting",
  failed: "Failed",
  settled: "Settled",
  unknown: "Unknown"
}
export function view(model: Model, h: HtmlBuilder<Message>): Document {
  const { div, span, button, p, strong } = h
  const cls = h.Class
  const text = (value: string, style = "") => span([cls(style)], [value])
  const action = (label: string, message: Message, style = "") =>
    button([cls(style), h.OnClick(message), h.Type("button")], [label])
  const graph = layout(model.threads)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const selected = byId.get(model.selected)
  const filtered = graph.nodes.filter((n) =>
    matches(n, model.query, model.filter)
  )
  const roots = model.threads.filter((t) => !t.parent)
  const camera = model.camera
  const visible = graph.nodes.filter(
    (n) =>
      (n.x + 198) * camera.zoom + camera.x > -30 &&
      n.x * camera.zoom + camera.x < model.width + 30 &&
      (n.y + 48) * camera.zoom + camera.y > -30 &&
      n.y * camera.zoom + camera.y < model.height + 30
  )
  const focus = (id: string) => Message.Focus({ id })
  const zoom = (factor: number) =>
    Message.Zoom({ factor, x: model.width / 2, y: model.height / 2 })
  const statusCounts = statuses.map((status) => ({
    status,
    count: model.threads.filter((t) => t.status === status).length
  }))
  const setting = (
    key: "pollMs" | "eventLimit" | "requestMs" | "actor",
    label: string
  ) =>
    h.label(
      [],
      [
        text(label),
        h.input([
          h.Value(String(model[key])),
          h.Type(key === "actor" ? "text" : "number"),
          h.Attribute("min", "1"),
          h.OnChange((value) => Message.Setting({ key, value }))
        ])
      ]
    )
  return {
    title: "Canvas · Tardigrade",
    body: div(
      [cls("app")],
      [
        h.aside(
          [cls("rail")],
          [
            div(
              [cls("brand")],
              [
                span([cls("brandmark")], ["t"]),
                div(
                  [],
                  [
                    strong([], ["tardigrade"]),
                    text("OBSERVATION SPACE", "eyebrow")
                  ]
                )
              ]
            ),
            div(
              [cls("rail-section")],
              [
                text("WORKSPACE", "eyebrow"),
                div(
                  [cls("workspace-name")],
                  [
                    text("◈", "workspace-icon"),
                    text("Agent operations"),
                    text("01", "muted mono")
                  ]
                )
              ]
            ),
            div(
              [cls("rail-section")],
              [
                text("VIEWS", "eyebrow"),
                div(
                  [cls("active-nav")],
                  [text("⌘"), text("Thread canvas"), text("BETA", "badge")]
                ),
                p([cls("rail-copy")], ["One space. Every thread."])
              ]
            ),
            div(
              [cls("rail-section fleet")],
              [
                text("FLEET STATUS", "eyebrow"),
                ...statusCounts
                  .filter((s) => s.status !== "unknown" || s.count > 0)
                  .map(({ status, count }) =>
                    button(
                      [
                        cls(
                          `status-filter ${model.filter === status ? "chosen" : ""}`
                        ),
                        h.OnClick(
                          Message.Filter({
                            status: model.filter === status ? "all" : status
                          })
                        )
                      ],
                      [
                        text("", `dot ${status}`),
                        text(labels[status]),
                        text(String(count), "mono count")
                      ]
                    )
                  )
              ]
            ),
            div(
              [cls("rail-section run-section")],
              [
                div(
                  [cls("section-label")],
                  [
                    text(
                      model.query || model.filter !== "all"
                        ? "RESULTS"
                        : "ROOT THREADS",
                      "eyebrow"
                    ),
                    text(
                      String(
                        model.query || model.filter !== "all"
                          ? filtered.length
                          : roots.length
                      ),
                      "mono muted"
                    )
                  ]
                ),
                div(
                  [cls("root-list")],
                  (model.query || model.filter !== "all"
                    ? filtered
                    : roots
                  ).map((t) =>
                    button(
                      [
                        cls(
                          `root-item ${selected?.id === t.id ? "chosen" : ""}`
                        ),
                        h.OnClick(focus(t.id)),
                        h.Title(t.id)
                      ],
                      [
                        text("", `dot ${t.status}`),
                        div(
                          [],
                          [
                            text(
                              t.group === "Live threads"
                                ? t.id
                                : model.query || model.filter !== "all"
                                  ? `${t.name} · ${t.group}`
                                  : t.group,
                              "root-name"
                            ),
                            text(`${t.events} events · ${t.id}`, "root-meta")
                          ]
                        )
                      ]
                    )
                  )
                )
              ]
            ),
            div(
              [cls("rail-bottom")],
              [
                text("◉", "connection-dot"),
                div(
                  [],
                  [
                    text("Built with Foldkit", "rail-foot-title"),
                    text("Model → Update → View", "mono tiny")
                  ]
                )
              ]
            )
          ]
        ),
        h.main(
          [cls("main")],
          [
            h.header(
              [cls("topbar")],
              [
                div(
                  [cls("breadcrumb")],
                  [
                    text("Workspace", "muted"),
                    text("/", "muted"),
                    text("Canvas")
                  ]
                ),
                div(
                  [cls("top-actions")],
                  [
                    div(
                      [
                        cls("source-switch"),
                        h.Role("group"),
                        h.AriaLabel("Data source")
                      ],
                      [
                        action(
                          "Demo",
                          Message.Source({ source: "demo" }),
                          model.source === "demo" ? "active" : ""
                        ),
                        action(
                          "Live",
                          Message.Source({ source: "live" }),
                          model.source === "live" ? "active" : ""
                        )
                      ]
                    ),
                    action("Settings", Message.Settings(), "quiet")
                  ]
                )
              ]
            ),
            div(
              [cls("page-heading")],
              [
                div(
                  [],
                  [
                    div(
                      [cls("heading-line")],
                      [
                        h.h1([], ["Thread canvas"]),
                        text(
                          model.source === "demo"
                            ? "SIMULATED"
                            : "SERVER EVENTS",
                          `source-badge ${model.source}`
                        )
                      ]
                    ),
                    p(
                      [],
                      [
                        model.source === "demo"
                          ? "Follow the work across agents, branches, and decisions."
                          : `Actor ${model.actor} · ${model.loading ? "Reading server…" : model.refreshed ? `Updated ${new Date(model.refreshed).toLocaleTimeString()}` : "Waiting for server"}`
                      ]
                    )
                  ]
                ),
                div(
                  [cls("totals")],
                  [
                    strong([cls("mono")], [String(model.threads.length)]),
                    text("threads"),
                    span([cls("total-divider")]),
                    strong([cls("mono")], [String(roots.length)]),
                    text("roots")
                  ]
                )
              ]
            ),
            ...(model.settings
              ? [
                  div(
                    [cls("settings")],
                    [
                      setting("actor", "Actor"),
                      setting("pollMs", "Poll interval (ms)"),
                      setting("eventLimit", "Event limit"),
                      setting("requestMs", "Request timeout (ms)"),
                      action("Apply and refresh", Message.Refresh(), "solid"),
                      p(
                        [],
                        [
                          "Live uses the Vite /v1 proxy. Set CANVAS_API_URL before starting Vite. Positive integers only."
                        ]
                      )
                    ]
                  )
                ]
              : []),
            ...(model.error
              ? [
                  div(
                    [cls("error"), h.Role("alert")],
                    [text(model.error), action("Retry", Message.Refresh())]
                  )
                ]
              : []),
            div(
              [cls("toolbar")],
              [
                div(
                  [cls("search")],
                  [
                    text("⌕", "search-icon"),
                    h.input([
                      h.Type("search"),
                      h.Placeholder("Thread ID or name · Enter to jump"),
                      h.AriaLabel("Search threads"),
                      h.Value(model.query),
                      h.OnInput((query) => Message.Search({ query })),
                      h.OnKeyDownPreventDefault((key) =>
                        key === "Enter"
                          ? Option.some(Message.Jump())
                          : Option.none()
                      )
                    ])
                  ]
                ),
                action(
                  model.canvasMode === "threads"
                    ? "Activity map"
                    : "Thread map",
                  Message.CanvasMode({
                    mode:
                      model.canvasMode === "threads" ? "activity" : "threads"
                  }),
                  "filter-reset"
                ),
                action("Jump to thread", Message.Jump(), "filter-reset"),
                h.select(
                  [
                    cls("filter-reset"),
                    h.AriaLabel("Filter by state"),
                    h.Value(model.filter),
                    h.OnChange((status) => Message.Filter({ status }))
                  ],
                  [
                    h.option([h.Value("all")], ["All states"]),
                    ...statuses.map((status) =>
                      h.option([h.Value(status)], [labels[status]])
                    )
                  ]
                ),
                text(`${filtered.length} matching`, "mono matching"),
                ...(model.source === "live"
                  ? [
                      action(
                        model.loading ? "Refreshing…" : "↻ Refresh",
                        Message.Refresh(),
                        "quiet"
                      )
                    ]
                  : [text("256-thread sample", "sample-label")])
              ]
            ),
            ...(model.jumpError
              ? [p([cls("jump-feedback"), h.Role("status")], [model.jumpError])]
              : []),
            ...(model.query.trim()
              ? [
                  div(
                    [cls("jump-results"), h.AriaLabel("Thread search results")],
                    filtered.map((thread) =>
                      button(
                        [h.OnClick(focus(thread.id)), cls("jump-result")],
                        [text(thread.name), text(thread.id, "mono muted")]
                      )
                    )
                  )
                ]
              : []),
            div(
              [cls("stage")],
              [
                ...(model.canvasMode === "activity"
                  ? [activityView(model, h)]
                  : []),
                div(
                  [
                    cls(
                      `canvas ${model.drag ? "dragging" : ""} ${model.canvasMode === "activity" ? "canvas-hidden" : ""}`
                    ),
                    h.Id("canvas"),
                    h.Tabindex(0),
                    h.Role("region"),
                    h.AriaLabel(
                      "Thread graph. Drag to pan. Scroll to zoom. Use arrow keys to pan, plus or minus to zoom, and F to fit."
                    ),
                    h.OnMount(ObserveCanvas()),
                    h.OnPointerDown(
                      (_type, button, x, y, _at, _cx, _cy, _id, target) =>
                        button === 0 &&
                        !(target instanceof Element && target.closest("button"))
                          ? Option.some(Message.DragStart({ x, y }))
                          : Option.none()
                    ),
                    h.OnPointerMove(pointer),
                    h.OnPointerUp(() => Option.some(Message.DragEnd())),
                    h.OnPointerLeave(() => Option.some(Message.DragEnd())),
                    h.OnKeyDownPreventDefault((key) => {
                      if (key === "+" || key === "=")
                        return Option.some(zoom(1.2))
                      if (key === "-") return Option.some(zoom(1 / 1.2))
                      if (key.toLowerCase() === "f")
                        return Option.some(Message.Fit())
                      const dx =
                        key === "ArrowLeft"
                          ? 80
                          : key === "ArrowRight"
                            ? -80
                            : 0
                      const dy =
                        key === "ArrowUp" ? 80 : key === "ArrowDown" ? -80 : 0
                      return dx || dy
                        ? Option.some(Message.Pan({ x: dx, y: dy }))
                        : Option.none()
                    })
                  ],
                  [
                    div(
                      [cls("canvas-label")],
                      [
                        text("01 / RELATIONSHIP MAP", "eyebrow"),
                        text("Parent → child", "tiny muted")
                      ]
                    ),
                    ...(!model.threads.length
                      ? [
                          div(
                            [cls("empty")],
                            [
                              h.h2(
                                [],
                                [
                                  model.loading
                                    ? "Reading threads…"
                                    : "No threads to display"
                                ]
                              ),
                              p(
                                [],
                                [
                                  model.loading
                                    ? "The canvas loads records from your server."
                                    : "Select Demo to explore a sample, or check the live actor."
                                ]
                              )
                            ]
                          )
                        ]
                      : []),
                    ...(!filtered.length && model.threads.length
                      ? [
                          div(
                            [cls("no-results")],
                            [
                              text("No matching threads."),
                              action("Clear filters", Message.ClearFilters())
                            ]
                          )
                        ]
                      : []),
                    div(
                      [
                        cls("world"),
                        h.Style({
                          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`
                        })
                      ],
                      [
                        h.svg(
                          [
                            cls("edges"),
                            h.Attribute("width", String(graph.width)),
                            h.Attribute("height", String(graph.height)),
                            h.AriaHidden(true)
                          ],
                          graph.nodes.flatMap((n) => {
                            const parent = byId.get(n.parent)
                            if (!parent) return []
                            const x = parent.x + 198,
                              y = parent.y + 24
                            return [
                              h.path([
                                h.Attribute(
                                  "d",
                                  `M ${x} ${y} C ${x + 35} ${y}, ${n.x - 35} ${n.y + 24}, ${n.x} ${n.y + 24}`
                                ),
                                cls(
                                  n.id === model.selected ||
                                    n.parent === model.selected
                                    ? "edge selected-edge"
                                    : "edge"
                                )
                              ])
                            ]
                          })
                        ),
                        ...roots.map((t) => {
                          const n = byId.get(t.id)!
                          return div(
                            [
                              cls("cluster-label"),
                              h.Style({
                                left: `${n.x}px`,
                                top: `${n.y - 42}px`
                              })
                            ],
                            [
                              text(
                                t.group === "Live threads"
                                  ? "LIVE WORKFLOW"
                                  : t.group.toUpperCase()
                              ),
                              text(" /", "muted")
                            ]
                          )
                        }),
                        ...visible.map((n) =>
                          button(
                            [
                              cls(
                                `node ${n.status} ${n.id === model.selected ? "selected" : ""} ${matches(n, model.query, model.filter) ? "" : "dimmed"}`
                              ),
                              h.Style({ left: `${n.x}px`, top: `${n.y}px` }),
                              h.OnClick(Message.Select({ id: n.id })),
                              h.Title(
                                `${n.name} · ${labels[n.status]} · ${n.id}`
                              ),
                              h.AriaLabel(
                                `${n.name}, ${labels[n.status]}, ${n.id}`
                              )
                            ],
                            [
                              text(n.parent ? "↳" : "◈", "node-icon"),
                              div(
                                [cls("node-content")],
                                [
                                  text(n.name, "node-name"),
                                  text(
                                    `${n.events} events · ${n.parent ? "child" : "root"}`,
                                    "node-meta mono"
                                  )
                                ]
                              ),
                              text("", `dot ${n.status}`)
                            ]
                          )
                        )
                      ]
                    ),
                    div(
                      [cls("canvas-bottom")],
                      [
                        div(
                          [cls("zoom-controls")],
                          [
                            action("−", zoom(1 / 1.2)),
                            text(`${Math.round(camera.zoom * 100)}%`, "mono"),
                            action("+", zoom(1.2)),
                            action("Fit", Message.Fit(), "fit-button")
                          ]
                        ),
                        text("DRAG TO PAN · SCROLL TO ZOOM", "canvas-help mono")
                      ]
                    ),
                    div(
                      [cls("minimap"), h.AriaLabel("Graph overview")],
                      [
                        h.svg(
                          [
                            h.ViewBox(`0 0 ${graph.width} ${graph.height}`),
                            h.Attribute("width", "142"),
                            h.Attribute("height", "112"),
                            h.AriaHidden(true)
                          ],
                          [
                            ...graph.nodes.map((n) =>
                              h.rect([
                                h.Attribute("x", String(n.x)),
                                h.Attribute("y", String(n.y)),
                                h.Attribute("width", "198"),
                                h.Attribute("height", "40"),
                                cls(`mini-node ${n.status}`)
                              ])
                            ),
                            h.rect([
                              h.Attribute("x", String(-camera.x / camera.zoom)),
                              h.Attribute("y", String(-camera.y / camera.zoom)),
                              h.Attribute(
                                "width",
                                String(model.width / camera.zoom)
                              ),
                              h.Attribute(
                                "height",
                                String(model.height / camera.zoom)
                              ),
                              cls("viewport")
                            ])
                          ]
                        ),
                        action(
                          "Fit all threads ↗",
                          Message.Fit(),
                          "minimap-fit"
                        )
                      ]
                    )
                  ]
                ),
                h.aside(
                  [cls(`inspector ${selected ? "open" : ""}`)],
                  [
                    div(
                      [cls("inspector-heading")],
                      [
                        text("THREAD INSPECTOR", "eyebrow"),
                        selected
                          ? action(
                              "Close thread",
                              Message.CloseThread(),
                              "quiet"
                            )
                          : text("00", "mono muted")
                      ]
                    ),
                    ...(selected
                      ? [
                          div(
                            [cls("thread-summary")],
                            [
                              text("", `dot ${selected.status}`),
                              text(labels[selected.status], "status-label"),
                              h.h2([], [selected.name]),
                              p([cls("thread-id mono")], [selected.id]),
                              text(selected.group, "muted"),
                              action(
                                "Center thread",
                                focus(selected.id),
                                "parent-link"
                              )
                            ]
                          ),
                          div(
                            [cls("facts")],
                            [
                              div(
                                [],
                                [
                                  text("Events", "muted"),
                                  strong(
                                    [cls("mono")],
                                    [String(selected.events)]
                                  )
                                ]
                              ),
                              div(
                                [],
                                [
                                  text("Relationship", "muted"),
                                  strong(
                                    [],
                                    [
                                      selected.parent
                                        ? "Child thread"
                                        : "Root thread"
                                    ]
                                  )
                                ]
                              )
                            ]
                          ),
                          ...(selected.parent
                            ? [
                                button(
                                  [
                                    cls("parent-link"),
                                    h.OnClick(focus(selected.parent))
                                  ],
                                  [text("↖"), text("Go to parent thread")]
                                )
                              ]
                            : []),
                          div(
                            [
                              cls("inspector-tabs"),
                              h.Role("group"),
                              h.AriaLabel("Thread view")
                            ],
                            [
                              button(
                                [
                                  h.OnClick(
                                    Message.InspectorTab({
                                      tab: "conversation"
                                    })
                                  ),
                                  h.AriaPressed(
                                    String(
                                      model.inspectorTab === "conversation"
                                    )
                                  )
                                ],
                                ["Conversation"]
                              ),
                              button(
                                [
                                  h.OnClick(
                                    Message.InspectorTab({ tab: "events" })
                                  ),
                                  h.AriaPressed(
                                    String(model.inspectorTab === "events")
                                  )
                                ],
                                ["Events"]
                              )
                            ]
                          ),
                          ...(model.inspectorTab === "conversation"
                            ? [
                                div(
                                  [cls("conversation")],
                                  [
                                    ...model.events.flatMap((event) =>
                                      event.message
                                        ? [
                                            h.article(
                                              [
                                                cls(
                                                  `message ${event.message.role}`
                                                )
                                              ],
                                              [
                                                text(
                                                  event.message.role === "user"
                                                    ? "USER"
                                                    : "ASSISTANT",
                                                  "eyebrow"
                                                ),
                                                p([], [event.message.text])
                                              ]
                                            )
                                          ]
                                        : []
                                    ),
                                    ...(!model.eventLoading &&
                                    !model.events.some((event) => event.message)
                                      ? [
                                          p(
                                            [cls("conversation-empty")],
                                            [
                                              "No conversation messages in the loaded events."
                                            ]
                                          )
                                        ]
                                      : []),
                                    ...(selected.status === "running" ||
                                    selected.status === "waiting"
                                      ? [
                                          p(
                                            [cls("conversation-empty")],
                                            [
                                              selected.status === "running"
                                                ? "This thread is running."
                                                : "This thread is waiting."
                                            ]
                                          )
                                        ]
                                      : []),
                                    ...(selected.status === "failed"
                                      ? [
                                          p(
                                            [cls("error")],
                                            [
                                              "This thread failed. Select Events to inspect its activity."
                                            ]
                                          )
                                        ]
                                      : []),
                                    ...graph.nodes
                                      .filter(
                                        (node) => node.parent === selected.id
                                      )
                                      .map((child) =>
                                        action(
                                          `Open child: ${child.name}`,
                                          focus(child.id),
                                          "child-thread-link"
                                        )
                                      )
                                  ]
                                )
                              ]
                            : []),
                          div(
                            [cls("timeline-heading")],
                            [
                              strong(
                                [],
                                [
                                  model.inspectorTab === "events"
                                    ? "Event sequence"
                                    : "Conversation"
                                ]
                              ),
                              text(String(model.events.length), "mono muted")
                            ]
                          ),
                          p(
                            [cls("event-note")],
                            [
                              model.source === "demo"
                                ? "Simulated events. Select Live for server records."
                                : `First ${model.eventLimit} events maximum. ${model.events.length} of ${selected.events} loaded.`
                            ]
                          ),
                          ...(model.eventLoading
                            ? [
                                p(
                                  [cls("event-note"), h.Role("status")],
                                  ["Reading events…"]
                                )
                              ]
                            : []),
                          ...(model.eventError
                            ? [
                                p(
                                  [cls("error"), h.Role("alert")],
                                  [model.eventError]
                                )
                              ]
                            : []),
                          ...(model.inspectorTab === "events"
                            ? [
                                div(
                                  [cls("timeline")],
                                  model.events.map((event, i) =>
                                    div(
                                      [
                                        cls(
                                          `event ${event.tag.includes("Failed") ? "event-failed" : ""} ${event.seq === model.activitySeq ? "arrival-selected" : ""}`
                                        )
                                      ],
                                      [
                                        div(
                                          [cls("event-track")],
                                          [text("", "event-dot")]
                                        ),
                                        div(
                                          [cls("event-body")],
                                          [
                                            div(
                                              [cls("event-title")],
                                              [
                                                strong([], [event.tag]),
                                                text(
                                                  `#${event.seq}`,
                                                  "mono muted"
                                                )
                                              ]
                                            ),
                                            ...(event.detail
                                              ? [p([], [event.detail])]
                                              : []),
                                            text(
                                              model.source === "demo"
                                                ? `+${(event.at / 1000).toFixed(2)}s`
                                                : event.at
                                                  ? new Date(
                                                      event.at
                                                    ).toLocaleTimeString()
                                                  : `Sequence ${i + 1}`,
                                              "mono event-time"
                                            )
                                          ]
                                        )
                                      ]
                                    )
                                  )
                                )
                              ]
                            : []),
                          ...(!model.events.length &&
                          !model.eventLoading &&
                          !model.eventError
                            ? [
                                p(
                                  [cls("event-note")],
                                  ["No events returned for this thread."]
                                )
                              ]
                            : [])
                        ]
                      : [
                          div(
                            [cls("inspector-empty")],
                            [
                              div([cls("selection-symbol")], ["⌖"]),
                              h.h2([], ["Follow a thread"]),
                              p(
                                [],
                                [
                                  "Click a node to read its conversation. Use Events to inspect its activity."
                                ]
                              ),
                              div(
                                [cls("inspector-hint")],
                                [
                                  text("TRY THIS", "eyebrow"),
                                  p(
                                    [],
                                    [
                                      "Choose a failed thread. Trace its parent. See where the work stopped."
                                    ]
                                  ),
                                  action(
                                    "Show failed threads ↗",
                                    Message.Filter({ status: "failed" }),
                                    "text-button"
                                  )
                                ]
                              )
                            ]
                          )
                        ]),
                    div(
                      [cls("inspector-footer")],
                      [
                        text("TARDIGRADE EVENTS", "eyebrow"),
                        p(
                          [],
                          [
                            "Thread relationships and event sequences. OpenTelemetry ingestion is not connected."
                          ]
                        )
                      ]
                    )
                  ]
                )
              ]
            ),
            h.footer(
              [cls("statusbar")],
              [
                text(
                  "",
                  `dot ${model.source === "demo" ? "waiting" : model.error ? "failed" : "settled"}`
                ),
                text(
                  model.source === "demo"
                    ? "Demo data · deterministic sample"
                    : model.error
                      ? "Connection failed · records may be stale"
                      : `Live · polling every ${model.pollMs / 1000}s`
                ),
                text(
                  `${visible.length} nodes in view / ${graph.nodes.length} total`,
                  "mono statusbar-right"
                )
              ]
            )
          ]
        )
      ]
    )
  }
}
