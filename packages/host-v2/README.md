# Host

Host v2 runs the effects exposed by a core-v2 actor. createHost accepts an actor, a journal, and explicit maxEffects and failure-event policies. agentHost supplies the failure-event constructor for agent-v2.

Run the local example with:

    bun packages/host-v2/examples/agent.ts

The example defines its own actor composition and imports service Layers separately. It prints the complete event log after model inference, permission checking, tool execution, and the final response.

The host records each request before execution and each result afterward. It recomputes the actor snapshot after each append and selects one effect at a time. select can override composition-order selection. maxEffects is required; reaching it returns a limit result containing the configured value. Calling run() without incoming events resumes from the journal.

Journal supplies read() and append(expectedRevision, event). Appends must atomically reject revision conflicts. memoryJournal uses structured clones and is not durable storage. One host instance rejects concurrent runs; revision checking detects competing journal writers but does not lease external execution across processes.

Effect cancellation and defects propagate, retaining committed events. A recorded request without a result needs reconciliation before the agent can resume. Resolve its external outcome and append the result through the journal. Automatic retries and exactly-once external execution are not supplied. Applications can use call identities as external idempotency keys.

Typed execution failures become failure events and stop the run. Agent tool handlers represent typed tool failures as tool-result errors so inference can respond. The host does not interpret completion, waiting, or interruption to admit inputs. Machines validate method deliveries against their current interfaces; application policy governs raw domain events.

## Local SQLite

Import sqliteJournal from @clavia/tardigrade-host-v2/sqlite under Bun. Supply path, stream, and a synchronous Effect codec for the event type. A database can contain multiple independent named streams. The caller closes the journal when finished; the SQLite module is a separate entry point so importing the general host does not require Bun SQLite.

    const journal = sqliteJournal({
      path: ".tardigrade/agent-v2.sqlite",
      stream: "assistant",
      schema: AgentEvent,
    })

Run the persistent example with:

    bun packages/host-v2/examples/sqlite.ts

The default database is .tardigrade/agent-v2.sqlite and the default stream is assistant. The first run submits a demo message. Later runs replay that stream without adding input. Pass a database path, stream, and optional message to create another turn:

    bun packages/host-v2/examples/sqlite.ts .tardigrade/agent-v2.sqlite assistant "What is 2 + 3?"

The SQLite example uses the real OpenRouter model service and live HTTP fetch tool. It requires OPENROUTER_API_KEY in the environment or root .env. OPENROUTER_MODEL defaults to anthropic/claude-haiku-4.5; MAX_TOKENS defaults to 2048 and MODEL_TIMEOUT_MS to 60000. These defaults are exported by examples/openrouter.ts and can be overridden through the named environment variables. The actor allows five tool calls per turn and stops subsequent inference after $5 recorded spend. It prints the complete persisted log. Reopening a completed stream does not call the model again. Unfinished recorded requests retain the host's explicit reconciliation behavior.

SQLite checks the expected revision and inserts an event within an immediate transaction. busyTimeoutMs defaults to the exported DEFAULT_SQLITE_BUSY_TIMEOUT_MS (5000) and can be overridden. SQLite journal and synchronization modes retain their database defaults. Encoded events must be JSON-compatible; unsupported values fail instead of being silently omitted or converted. The supplied codec validates events on append and replay. No event migrations are supplied.

The nonpersistent examples/agent.ts entry point retains deterministic services for a local demonstration. Provider usage is logged to stderr and recorded in ModelReturned events. Summary usage is logged separately and is outside the inference budget. The real-model adapter reconstructs text and tool messages; provider-specific reasoning metadata and multimodal content are not preserved.

## Idle execution

When no effects are available, run returns status idle with the current combined view and recorded events. Idle does not mean complete: a machine may be waiting for external input. The host also reports limit when its execution budget is reached and failed after recording a typed execution failure. All three results include the current view.

New inputs pass through actor.append before they are persisted. Unknown or unavailable method calls therefore fail without appending the rejected invocation. The host does not gate delivery on the previous run's domain status. The CLI separately uses agentOutcome to label the conversation and preserves the host status as execution in its output.

## Interactive permission prompts

Run bun run chat:v2 for interactive chat. Its actor uses manual permission mode and pauses at awaitingPermission before tool execution. The CLI displays the tool name, arguments, and call identity, then accepts y or n. A denial becomes a tool-error result so the model can respond. /quit leaves the decision pending; reopening the same SQLite stream presents the request again.

The response uses the actor's resolvePermission method. The journal stores its ActorMethodInvoked envelope and the subsequent PermissionResolved event. The receiving permissions machine rejects unknown, completed, or duplicate requests. No host waiting policy is required: the host returns idle, and the CLI reads the permission machine's position. The noninteractive SQLite example retains automatic checks for registered tools.
