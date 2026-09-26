# Agent machines

Agent v2 supplies machines for user-defined core-v2 actors. It does not choose a fixed composition. The runnable composition is in ../host-v2/examples/agent.ts.

The available machines are system, trajectory, compact, infer, tools, permissions, and budget. Each machine with projected state accepts a state function. The supplied projections are optional building blocks. Views and typed ports connect these components; Effect programs supply execution requests.

Model, Summarizer, PermissionChecker, and ToolExecutor are required Effect services. tool() describes and validates a tool using an Effect Schema. toolLayer() supplies its handlers. The deterministic example uses local service Layers and performs no network calls; layers/language-model adapts an Effect AI LanguageModel with caller-supplied cost extraction and timeout. The host SQLite example supplies OpenRouter.

Budget limits are explicit. Tool usage and inference spend projections count the current turn. Inference budgeting stops subsequent calls after recorded spend reaches the limit and can overshoot by the cost of an admitted call. Summary cost is outside that budget. Tool denials become tool results without invoking handlers.

Compaction accepts maxEvents and summarizes earlier whole turns. This preserves retained model-call and tool-result relationships. If the active turn alone exceeds the limit, bounded context remains unavailable. Summary text is separate from the bounded event suffix and has no built-in token limit.

agentOutcome(events) supplies an optional interpretation of completion, failure, unfinished requests, and blocked execution. Applications can provide a different outcome function using their actor's combined view. Composition, propagation rounds, scheduling, and persistence remain caller choices.

These packages provide an initial agent implementation. Streaming, code execution, subagent packages, and persistent object storage are not supplied.

## Input clipping

compact accepts maxInputChars, defaulting to the exported DEFAULT_MAX_INPUT_CHARS (16000). It bounds user and assistant text, tool arguments, tool outputs, errors, and summary text before exposing context to inference. Limits apply to each content payload; event IDs, tool names, and call/result links remain intact. Tool payloads are measured as JSON text. An oversized payload becomes a truncated preview with its original length and applied limit. Text clipping is described in the view's clipped metadata, which the model adapter includes in the prompt.

The same policy bounds inputs sent to the summarizer. Original events and SQLite records are unchanged. This character limit is per payload, not a guarantee about the aggregate model token count. The separate maxEvents policy controls the retained event suffix.
