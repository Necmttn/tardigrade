import { ToolError } from "./errors"
import { Clock, Context, Effect, Schema } from "effect"
import { tool } from "./tool"
import { definePackage } from "./package"

export const Alarm = Schema.Struct({
  alarmId: Schema.NonEmptyString,
  at: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8_640_000_000_000_000)),
  message: Schema.NonEmptyString,
})
export type Alarm = typeof Alarm.Type

export class AlarmScheduler extends Context.Service<AlarmScheduler, {
  readonly set: (alarm: Alarm) => Effect.Effect<void, Error>
  readonly cancel: (alarmId: string) => Effect.Effect<void, Error>
}>()("tardigrade/experimental/packages/AlarmScheduler") {}

// alarm records reminders through the actor's alarm scheduler.
export function alarm() {
  return definePackage({ name: "alarm", description: "Schedule and cancel recorded reminders.", methods: [
    tool({
      name: "set_alarm",
      description: "Record a reminder and return its alarmId immediately. Supply message and either afterSeconds or an ISO timestamp with a timezone in at. An overdue alarm rings when the host is running.",
      input: Schema.Union([
        Schema.Struct({ message: Schema.NonEmptyString, afterSeconds: Schema.Finite }),
        Schema.Struct({ message: Schema.NonEmptyString, at: Schema.String }),
      ]),
      run: (input, call) => Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const value = yield* Effect.try({
          try: () => {
            if (!input.message.trim()) throw new ToolError("Alarm message must not be empty")
            let at: number
            if ("afterSeconds" in input) {
              if (!Number.isFinite(input.afterSeconds) || input.afterSeconds <= 0) throw new ToolError("afterSeconds must be finite and positive")
              at = Math.ceil(now + input.afterSeconds * 1000)
            } else {
              if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)) throw new ToolError("at must include an explicit timezone")
              at = Date.parse(input.at)
            }
            return { alarmId: `alarm:${call.callId}`, at, message: input.message }
          },
          catch: ToolError.from,
        })
        const validated = yield* Schema.decodeEffect(Alarm)(value).pipe(Effect.mapError(ToolError.from))
        yield* (yield* AlarmScheduler).set(validated)
        return validated
      }),
    }),
    tool({
      name: "cancel_alarm",
      description: "Cancel a pending reminder by alarmId.",
      input: Schema.Struct({ alarmId: Schema.NonEmptyString }),
      run: ({ alarmId }) => Effect.gen(function* () {
        yield* (yield* AlarmScheduler).cancel(alarmId)
        return { alarmId, cancelled: true }
      }),
    }),
  ] })
}
