# Effect stable migration patches

This ledger tracks behavior carried by the `@tardie/ai*` fork packages while Tardigrade moves from Effect RC imports to the stable Effect package family.

| Patch | Package area | Status against Effect 4.0.1 | Disposition | Acceptance evidence |
| --- | --- | --- | --- | --- |
| Deferred tool validation | Shared AI wrapper | Not upstreamed | Port the Tardigrade wrapper and retain `ToolCallValidationError` semantics; stable rejects malformed streamed calls before deferred completion | `packages/model/src/providers/response.test.ts` |
| Scoped response formats | Shared AI wrapper | Owned | Port `ResponseFormat` and its text versus object precedence | `packages/model/src/providers/response-format.test.ts` |
| Output-limit completion | OpenAI, Anthropic, compatible | Needs verification | Stable handles incomplete responses, but malformed tool JSON still differs in deferred mode | `packages/model/src/providers/response.test.ts` |
| Raw usage metadata | OpenAI, compatible | Not upstreamed | Stable exposes normalized usage but drops the raw OpenAI finish metadata; decide whether to port the metadata patch | Provider stream fixtures |
| Completion evidence | Compatible | Upstreamed in substance | Retain the bare-sentinel and missing-finish regression tests | `packages/model/src/providers/response.test.ts` |
| Reasoning replay | Compatible, OpenRouter | Upstreamed in substance | Verify durable replay and provider metadata before dropping fork code | Agent replay tests |
| Shared approval metadata | Compatible | Upstreamed | Compare declarations and remove duplicate fork types | Provider typecheck |
| Nullable stream fields | Compatible | Upstreamed | Verify null roles, names, IDs, and continuation fragments | Compatible provider fixtures |
| OpenRouter sentinel | OpenRouter | Upstreamed | Run combined and segmented sentinel fixtures against stable | `packages/model/src/providers/response.test.ts` |
| OpenAI Responses sentinel | OpenAI | Not upstreamed | Stable fails when the terminal response and `[DONE]` share one chunk; retain the client parser patch | `packages/model/src/providers/response.test.ts` |
| OpenAI request boundary fixes | OpenAI | Upstreamed in substance | Retain explicit include and encrypted reasoning regressions during replacement | Provider boundary tests |
| Compatible request boundary fixes | Compatible | Verify | Retain choice count and choice index regressions until stable passes | Provider boundary tests |
| Anthropic usage accumulation | Anthropic | Upstreamed in substance | Verify null, omitted, and zero counter behavior | Anthropic stream fixtures |
| Anthropic thinking display | Anthropic | Not upstreamed | Port configuration and request mapping if the contract remains required | Anthropic config tests |
| Anthropic reasoning usage | Anthropic | Not upstreamed | Port `thinking_tokens` mapping and generated declarations | Anthropic usage tests |
| Provider configuration schemas | All providers | Not upstreamed | Decide whether to port `ConfigSchema` and `ModelConfigSchema` | Config schema tests |
| Bedrock provider and error policy | Bedrock | Owned | Port the provider to stable imports; the published package still imports removed `effect/Encoding` | `packages/model/src/providers/bedrock.test.ts` |
| Checkpoint digest encoding | Core checkpoint service | Stable API gap | Keep the local byte-to-hex encoder because `effect@4.0.1` exports neither `Encoding` nor `effect/Encoding` | `packages/core/src/services/checkpoint.ts` |

Stable provider packages are `@tardie/ai-openai`, `@tardie/ai-anthropic`, `@tardie/ai-openai-compat`, and `@tardie/ai-openrouter`, all at `4.0.1` for this migration.

## Import inventory at migration start

The worktree contains 178 unstable import occurrences across 142 files. The largest groups are AI (49), HTTP (40), persistence (25), RPC (15), reactivity (15), HTTP API (11), SQL (9), and CLI (8). Stable renames `effect/unstable/httpapi` to `effect/http-api`; the other used namespaces retain their final path name without the `unstable` segment.
