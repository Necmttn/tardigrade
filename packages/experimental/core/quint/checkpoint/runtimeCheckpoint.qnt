// runtimeCheckpoint models atomic checkpoint publication and crash recovery (visibleEquivalent).
// Two durable Boolean atoms share a journal cursor; a derived projection reads both.
// Storage commits atomically, codecs preserve state, and the actor is isolated from concurrent writers.
// Effect lifecycle admission, dynamic graph discovery, and TypeScript refinement are outside this model.
// The checked instance has three-event journals; induction covers arbitrary transition counts.
// Run verification in a temporary directory to keep checker artifacts outside the repository:
// runtime_model="$PWD/packages/experimental/core/quint/checkpoint/runtimeCheckpoint.qnt"
// verification_dir=$(mktemp -d /tmp/tardigrade-quint-runtime.XXXXXX)
// (cd "$verification_dir" && JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home quint verify "$runtime_model" --inductive-invariant=invariant --invariants checkpointSound visibleEquivalent)
module runtimeCheckpoint {
  type State = (bool, bool)
  pure val capacity = 3
  pure val events = Set(false, true)
  pure val states = tuples(events, events)
  pure val phases = Set("live", "prepared", "committed", "down", "recovering")
  pure val initial = (false, false)
  pure val histories = 1.to(capacity).fold(Set(List()), (prefixes, _) =>
    prefixes.union(prefixes.fold(Set(List()), (output, prefix) =>
      output.union(events.map(event => prefix.append(event))))))
  pure def reduce(state: State, event: bool): State = (state._1 != event, if (event) state._1 else state._2)
  pure def replay(history: List[bool]): State = history.foldl(initial, (state, event) => reduce(state, event))
  pure def graph(state: State): (bool, bool, bool) = (state._1, state._2, state._1 != state._2)

  var journal: List[bool]
  var checkpointPosition: int
  var checkpointState: State
  var phase: str
  var live: State
  var cursor: int
  var preparedState: State
  var batch: List[bool]
  var saveCheckpoint: bool

  action init = all {
    journal' = List(),
    checkpointPosition' = 0,
    checkpointState' = initial,
    phase' = "live",
    live' = initial,
    cursor' = 0,
    preparedState' = initial,
    batch' = List(),
    saveCheckpoint' = false,
  }

  action prepare = {
    nondet event = events.oneOf()
    nondet save = Set(false, true).oneOf()
    all {
      phase == "live", journal.length() < capacity,
      journal' = journal, checkpointPosition' = checkpointPosition, checkpointState' = checkpointState,
      phase' = "prepared", live' = live, cursor' = cursor,
      preparedState' = reduce(live, event), batch' = List(event), saveCheckpoint' = save,
    }
  }

  action prepareCheckpoint = all {
    phase == "live",
    journal' = journal, checkpointPosition' = checkpointPosition, checkpointState' = checkpointState,
    phase' = "prepared", live' = live, cursor' = cursor,
    preparedState' = live, batch' = List(), saveCheckpoint' = true,
  }

  // commit publishes the event batch and optional global checkpoint in one storage transition.
  action commit = all {
    phase == "prepared",
    journal' = journal.concat(batch),
    checkpointPosition' = if (saveCheckpoint) journal.length() + batch.length() else checkpointPosition,
    checkpointState' = if (saveCheckpoint) preparedState else checkpointState,
    phase' = "committed",
    live' = live,
    cursor' = cursor,
    preparedState' = preparedState,
    batch' = batch,
    saveCheckpoint' = saveCheckpoint,
  }

  action publish = all {
    phase == "committed",
    journal' = journal,
    checkpointPosition' = checkpointPosition,
    checkpointState' = checkpointState,
    phase' = "live",
    live' = preparedState,
    cursor' = cursor,
    preparedState' = preparedState,
    batch' = List(),
    saveCheckpoint' = false,
  }

  // crash discards volatile preparation and live state while preserving committed storage.
  action crash = all {
    journal' = journal,
    checkpointPosition' = checkpointPosition,
    checkpointState' = checkpointState,
    phase' = "down",
    live' = initial,
    cursor' = 0,
    preparedState' = initial,
    batch' = List(),
    saveCheckpoint' = false,
  }

  action restore = all {
    phase == "down",
    journal' = journal,
    checkpointPosition' = checkpointPosition,
    checkpointState' = checkpointState,
    phase' = "recovering",
    live' = checkpointState,
    cursor' = checkpointPosition,
    preparedState' = preparedState,
    batch' = batch,
    saveCheckpoint' = saveCheckpoint,
  }

  action replayNext = all {
    phase == "recovering",
    cursor < journal.length(),
    journal' = journal,
    checkpointPosition' = checkpointPosition,
    checkpointState' = checkpointState,
    phase' = phase,
    live' = reduce(live, journal.nth(cursor)),
    cursor' = cursor + 1,
    preparedState' = preparedState,
    batch' = batch,
    saveCheckpoint' = saveCheckpoint,
  }

  action expose = all {
    phase == "recovering",
    cursor == journal.length(),
    journal' = journal,
    checkpointPosition' = checkpointPosition,
    checkpointState' = checkpointState,
    phase' = "live",
    live' = live,
    cursor' = cursor,
    preparedState' = preparedState,
    batch' = batch,
    saveCheckpoint' = saveCheckpoint,
  }

  action step = any { prepare, prepareCheckpoint, commit, publish, crash, restore, replayNext, expose }

  val checkpointSound = checkpointState == replay(journal.slice(0, checkpointPosition))
  val visibleEquivalent = (phase == "live" or phase == "prepared") implies graph(live) == graph(replay(journal))
  val invariant = all {
    journal.in(histories),
    checkpointPosition.in(0.to(capacity)), checkpointPosition <= journal.length(),
    checkpointState.in(states), live.in(states), preparedState.in(states),
    phase.in(phases), cursor.in(0.to(capacity)),
    batch.in(Set(List(), List(false), List(true))), saveCheckpoint.in(events),
    checkpointSound,
    visibleEquivalent,
    (phase == "prepared") implies all {
      journal.length() + batch.length() <= capacity,
      preparedState == replay(journal.concat(batch)),
    },
    (phase == "committed") implies preparedState == replay(journal),
    (phase == "recovering") implies all {
      checkpointPosition <= cursor, cursor <= journal.length(),
      live == replay(journal.slice(0, cursor)),
    },
  }
}
