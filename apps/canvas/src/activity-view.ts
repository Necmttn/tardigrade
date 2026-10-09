import type { HtmlBuilder } from "foldkit/html"
import { arrivals } from "./activity"
import { Message, type Model } from "./main"

export function activityView(model: Model, h: HtmlBuilder<Message>) {
  const selected = model.threads.find((thread) => thread.id === model.selected)
  const records = arrivals(model.events)
  const chosen =
    records.find((row) => row.event.seq === model.activitySeq) ?? records.at(-1)
  const label = (value: string, cls = "") => h.span([h.Class(cls)], [value])
  const action = (value: string, message: Message, cls = "") =>
    h.button([h.Class(cls), h.OnClick(message)], [value])
  return h.section(
    [h.Class("activity-map"), h.AriaLabel("Thread activity map")],
    [
      h.div(
        [h.Class("activity-intro")],
        [
          label("02 / EVENT DELIVERY", "eyebrow"),
          h.h2([], ["What activates this thread?"]),
          h.p(
            [],
            [
              "Follow an incoming event into the thread, then inspect its recorded activity."
            ]
          )
        ]
      ),
      ...(selected
        ? [
            h.div(
              [h.Class("activity-layers")],
              [
                h.div(
                  [h.Class("activity-layer sources")],
                  [
                    label("01  SOURCES", "eyebrow"),
                    ...(records.length
                      ? records.map((row) =>
                          h.button(
                            [
                              h.Class(
                                `arrival ${chosen?.event.seq === row.event.seq ? "active" : ""}`
                              ),
                              h.OnClick(
                                Message.InspectArrival({ seq: row.event.seq })
                              )
                            ],
                            [
                              label(row.source, "arrival-source"),
                              label(row.event.tag, "mono"),
                              label(`#${row.event.seq}`, "arrival-seq mono")
                            ]
                          )
                        )
                      : [
                          h.p(
                            [],
                            [
                              model.eventLoading
                                ? "Reading arrivals…"
                                : "No incoming events in the loaded records."
                            ]
                          )
                        ])
                  ]
                ),
                h.div([h.Class("flow-connector"), h.AriaHidden(true)], ["→"]),
                h.div(
                  [h.Class("activity-layer delivery")],
                  [
                    label("02  DELIVERY", "eyebrow"),
                    h.div(
                      [h.Class("delivery-record")],
                      [
                        label(
                          chosen ? "RECORDED" : "WAITING",
                          "delivery-state"
                        ),
                        h.strong(
                          [],
                          [chosen?.event.tag ?? "Awaiting an event"]
                        ),
                        h.p(
                          [],
                          [
                            chosen
                              ? `Event #${chosen.event.seq}`
                              : "Select Replay demo to inspect the activation sequence."
                          ]
                        ),
                        ...(chosen?.event.at
                          ? [
                              label(
                                model.source === "demo"
                                  ? `+${(chosen.event.at / 1000).toFixed(2)}s`
                                  : new Date(
                                      chosen.event.at
                                    ).toLocaleTimeString(),
                                "mono"
                              )
                            ]
                          : [])
                      ]
                    )
                  ]
                ),
                h.div([h.Class("flow-connector"), h.AriaHidden(true)], ["→"]),
                h.div(
                  [h.Class("activity-layer target")],
                  [
                    label("03  THREAD", "eyebrow"),
                    h.button(
                      [
                        h.Class(`activity-thread ${selected.status}`),
                        h.OnClick(Message.InspectorTab({ tab: "conversation" }))
                      ],
                      [
                        label(selected.status.toUpperCase(), "delivery-state"),
                        h.strong([], [selected.name]),
                        label(selected.id, "mono")
                      ]
                    ),
                    h.div(
                      [h.Class("next-activity")],
                      [
                        label(
                          chosen?.next
                            ? chosen.next.tag
                            : "No later activity loaded",
                          "next-title"
                        ),
                        h.p(
                          [],
                          [
                            chosen?.linked
                              ? "Same turn identifier"
                              : chosen?.next
                                ? "Later in the log. Causality is not established."
                                : "An arrival does not prove that execution started."
                          ]
                        ),
                        ...(chosen?.next &&
                        chosen.event.at > 0 &&
                        chosen.next.at >= chosen.event.at
                          ? [
                              label(
                                `${chosen.next.at - chosen.event.at} ms to this record`,
                                "mono"
                              )
                            ]
                          : [])
                      ]
                    )
                  ]
                )
              ]
            ),
            ...(model.source === "demo"
              ? [
                  h.div(
                    [h.Class("wake-controls")],
                    [
                      label("SIMULATED ACTIVATION", "eyebrow"),
                      h.select(
                        [
                          h.AriaLabel("Demo event source"),
                          h.Value(model.demoWakeKind),
                          h.OnChange((kind) =>
                            Message.WakeSource({
                              kind:
                                kind === "alarm"
                                  ? "alarm"
                                  : kind === "response"
                                    ? "response"
                                    : "message"
                            })
                          )
                        ],
                        [
                          h.option([h.Value("message")], ["Webhook"]),
                          h.option([h.Value("alarm")], ["Alarm"]),
                          h.option([h.Value("response")], ["Child response"])
                        ]
                      ),
                      action("Replay demo", Message.ReplayWake(), "solid"),
                      h.button(
                        [
                          h.Disabled(
                            model.demoWakeStep < 0 || model.demoWakeStep >= 3
                          ),
                          h.OnClick(Message.StepWake()),
                          h.Class("next-wake")
                        ],
                        ["Next event →"]
                      ),
                      h.div(
                        [h.Class("wake-steps")],
                        ["Waiting", "Received", "Running", "Settled"].map(
                          (step, i) =>
                            label(
                              step,
                              i === model.demoWakeStep ? "current" : ""
                            )
                        )
                      )
                    ]
                  )
                ]
              : []),
            h.p(
              [h.Class("activity-note")],
              [
                model.source === "demo"
                  ? "Demo controls change local sample records only. Select a source to inspect its delivery."
                  : `This view covers the first ${model.eventLimit} events of the selected thread. Source names appear only when recorded. Missing host events cannot be inferred.`
              ]
            ),
            ...(chosen
              ? [
                  action(
                    `Inspect event #${chosen.event.seq}`,
                    Message.InspectArrival({ seq: chosen.event.seq }),
                    "inspect-arrival"
                  )
                ]
              : [])
          ]
        : [
            h.div(
              [h.Class("activity-empty")],
              [
                h.h3([], ["Select a thread"]),
                h.p(
                  [],
                  [
                    "Choose a root in the left panel, or find a thread with search."
                  ]
                )
              ]
            )
          ])
    ]
  )
}
