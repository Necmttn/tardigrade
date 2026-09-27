import type { Recorded } from "./internal/effects"

// Journal stores an ordered event prefix; append commits a batch atomically or rejects a stale expected length.
export interface Journal<Event extends object> {
  readonly read: () => Promise<readonly Recorded<Event>[]>
  readonly append: (expectedLength: number, events: readonly Recorded<Event>[]) => Promise<void>
}
