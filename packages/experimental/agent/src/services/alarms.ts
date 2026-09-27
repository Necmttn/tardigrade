import { Clock, Effect, Layer, Scope } from "effect"
import { AlarmScheduler } from "@clavia/tardigrade-experimental-packages"
import type { ActorRuntime } from "@clavia/tardigrade-experimental-core"
import { alarms } from "../atoms/alarms"
import type { Event } from "../event"

// alarmServices keeps a scoped timer aligned with the alarm atom, including replayed deadlines.
export function alarmServices(host: ActorRuntime<Event>) {
  return Layer.effect(AlarmScheduler, Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const watch = Effect.gen(function* () {
      yield* host.ready
      while (true) {
        const next = host.get(alarms).next
        const changed = Effect.callback<void>(resume => {
          const check = () => { if (host.get(alarms).next !== next) resume(Effect.void) }
          const stop = host.sub(alarms, check)
          check()
          return Effect.sync(stop)
        })
        if (!next) {
          yield* changed
          continue
        }
        const now = yield* Clock.currentTimeMillis
        if (next.at > now) {
          // watch chunks delays at the platform's signed 32-bit timer limit.
          yield* Effect.raceFirst(changed, Effect.sleep(Math.min(next.at - now, 2_147_483_647)))
          continue
        }
        yield* host.send([{ type: "AlarmRang", alarmId: next.alarmId }], get => get(alarms).next?.alarmId === next.alarmId)
      }
    })
    yield* Effect.forkIn(watch, scope)
    return {
      set: alarm => host.record({ type: "AlarmSet", alarm }),
      cancel: alarmId => host.record({ type: "AlarmCancelled", alarmId }),
    }
  }))
}
