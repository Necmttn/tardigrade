# Checkpointing existing effects

This design preserves `context.effect(tag, options)` and the persisted `transitionRef` field. Component authors declare state schemas and versions. The runtime continues to supply transition identity and completion metadata through its existing machinery.

```text
context.effect("search", { input, act })
                  |
                  v
       { seq, component, tag }
                  |
                  v
       SearchReturned { result, transitionRef }
```

## Existing contract

`bindTransitionContext` derives identity from the originating event position, component name, and author tag. It attaches `transitionRef` to the final returned domain event. `transitionKeyOf` reads that metadata for runtime completion tracking. Invocation ownership is inherited separately. Empty result batches leave work pending.

These properties already have real runtime coverage in `packages/core/src/runtime/reconciler.properties.test.ts`, including completion metadata, repeated tags on distinct events, conflicting references, and cold replay of partially completed work. There is no new declaration API, pending-key selector, handler registry, reference field, or effect lifecycle event in this design.

## Checkpoint boundary

```text
checkpoint at cursor N
  versioned component domain state
  framework-owned origin metadata needed by pending work
  child checkpoints and framework binding data

restore
  decode component data
  rebind runtime dependencies and framework contexts
  derive existing transitions
  replay the tail without executing external work
  reconcile remaining effects
```

The checkpoint and cursor describe the same committed log prefix. The component state codec encodes domain facts. Framework metadata preserves original transition coordinates and invocation ownership wherever reconstruction requires them. Its exact representation depends on the first real pending-effect migration; storing a reference alone cannot reconstruct an arbitrary action closure.

Transition output is derived code. A checkpoint does not serialize functions, runtime services, abort signals, or cached output objects. Pending domain data and freshly supplied services must suffice to derive the action again. Each component that fails this constraint needs a concrete investigation before adding an abstraction.

A completed effect already has durable completion evidence in its domain result event. Pending execution has a separate question: which domain facts and framework bindings are sufficient to reconstruct the existing effect declaration? The implementation must answer that question using a real component and its current API.

## First implementation slice

1. Select one existing leaf component with pending external work and identify the exact domain facts and framework bindings its output needs.
2. Add its state schema/version and checkpoint those facts plus the necessary framework metadata.
3. Restore into a fresh activation, derive work through the existing `context.effect` path, and execute through the existing reconciler.
4. Compare checkpoint plus every log tail against full replay, including transition keys, invocation ownership, domain state, and completion events.
5. Test crashes around execution and result commit, duplicate completion admission, and repeated tags on later events. Investigate permission, cancellation, and deferred results before expanding the slice.

External execution may be repeated after a crash before its completion event is committed. The reference remains stable across redelivery. Checkpoint equivalence does not establish exactly-once external execution.

Parent restore must preserve child-admission coordinates and rebind runtime interaction scopes. An unrelated event can advance the log head without changing a child's admission coordinates.


## Component implementation

`packageCalls` declares a state schema and version and uses the existing `context.effect` implementation unchanged. Its domain state already contains retained request and policy events. `RecordedEvent` encodes each event payload with its framework log position and reattaches that position on decode; authors do not construct or save a transition reference. Package methods come from the fresh component definition.

Component machines expose checkpoint encode/decode when the entire subtree has codecs. Restore validates component names, versions, state schemas, and ordered children and rebuilds output without running initialization. Authored parents checkpoint their own domain state and child-admission coordinates; sibling groups restore child outputs and reconciliation history. Groups without reconciliation retain no history.

The package-call tests compare fresh restore plus every tail against full replay and execute restored work through the reconciler. `createActorReconciler(source).checkpoint` synchronizes and captures projection state, completed keys, and the log watermark without executing pending work. `createActorReconciler(source, { checkpoint })` validates the snapshot, restores projections without initialization, and reads events after that watermark. Callers must supply a checkpoint from the same append-only log; the current log interface has no identity with which to verify that association.

This startup path supports actors built from checkpointable component transition projections, including nested parents and sibling groups. Actor control projections are supported when every method, validation projection, and component has a codec. Legacy cancellation callbacks remain unsupported. Invocation-owned effect execution still reads the log to reconstruct invocation context. Bun hosts automatically load and save checkpoints for supported actors; other platforms can bind `ActorCheckpointStore`. Completed-key history is retained for existing reconciliation semantics; this slice does not establish bounded checkpoint size.


## Bun persistence

Bun stores one row in `actor_checkpoint` inside each thread SQLite database. The row is replaced after a successful drive when the checkpoint watermark changes. A new activation loads the row and validates it before executing work. The database's existing thread identity check binds it to its event log.

`DEFAULT_BUN_ACTOR_CHECKPOINTS` is `true`; `checkpoints: false` disables loading and saving. Actors without checkpoint support use full replay. Corrupt or incompatible snapshots log a warning and fall back to full replay. Load, capture, and save failures log warnings without discarding committed domain events; a later activation can recover from the last stored prefix and its tail. Interruptions still propagate.

The Bun host restart test covers pending package work, original transition identity, stale checkpoint recovery after a failed write, replacement of the singleton row, incompatible data, and disabled checkpoints. Snapshot history has one row; its payload can still grow with retained component data and completed keys.


## Actor control state

Method projections declare `state: { version, schema }` using the component codec contract. Missing method or validation codecs disable actor checkpoint support; a changed method name, order, version, or incompatible state rejects restore. Component trees must also have complete codec coverage.

The control checkpoint includes method state, recursive component snapshots, cancellation requests and child links, accepted reply links and delivery state, outgoing dispatches, invocation deadlines, crossed alarms, and completion sets. Owner events use `RecordedEvent` so response, timeout, and cancellation transitions retain their original identities. Runtime functions and interaction handles are rebuilt from the fresh definitions.

Runtime tests compare every checkpoint cut and tail, including detached responses and child cancellation dispatch/settlement, and execute restored work and cancellation through response delivery. Method and component initializers throw in fresh test definitions to detect accidental prefix reconstruction. This support does not supply schemas to existing agent components or methods that lack them.
