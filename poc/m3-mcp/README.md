# POC: stdlib MCP server against Claude Code (F29)

Question: can a dependency-free stdio JSON-RPC 2.0 server do the MCP lifecycle correctly with Claude Code as the client, and how big is it?

**Verdict: go for the stdlib server.** `server.js` is 120 lines, no SDK, no new dependency; Claude Code connected, listed the tools and called all of them.

## Files

- `server.js`: newline-delimited JSON-RPC on stdin/stdout (protocol only on stdout, logs to stderr when `MAILPROOF_POC_LOG=1`). `initialize` (echoes a supported `protocolVersion`, else the latest it knows), `notifications/*` (ignored, no reply), `ping`, `tools/list`, `tools/call`; errors -32700, -32600, -32601, -32602 (-32603 for a bug); a JSON-RPC batch is handled too. Five read-only tools on one trail (`MAILPROOF_POC_TRAIL_DIR`, `MAILPROOF_POC_TRAIL`): `list`, `show` (`get`), `verify`, `replyFacts`, `counterparties`. Tool failures (bad arguments, unknown id, a library rejection) come back as `isError: true` results, not protocol errors. Stdin end or SIGTERM/SIGINT: wait for in-flight calls, `close()`, exit 0.
- `trail.mjs`: builds a throwaway trail from synthetic signed mail (`tests/helpers/thread-trail.js`; no real mail). `node trail.mjs <dir>` copies it somewhere persistent.
- `run.mjs`: spawns the server and drives the lifecycle and every error case (31 assertions); `node poc/m3-mcp/run.mjs`. Cleans up through `makeTmpDir`.

## Evidence

1. Scripted harness: 31/31 assertions pass (initialize with a supported and an unsupported version, notifications silent, ping, tools/list, all five tools, six `isError` cases, parse/invalid/method/params errors, a batch, a string id, stdout holds only JSON-RPC lines, stderr empty, exit 0 on stdin end).
2. Real client, Claude Code 2.1.322 (`claude -p`), config in the scratchpad:
   ```
   claude -p --mcp-config mcp.json --strict-mcp-config --allowedTools 'mcp__mailproof-poc__*' \
     --debug mcp --debug-file claude-debug.log --output-format stream-json --verbose "<prompt>"
   ```
   - The stream-json `init` event listed `mailproof-poc` as `connected` with all five `mcp__mailproof-poc__*` tools.
   - Claude Code asked for protocolVersion **2025-11-25** (the server echoed it); its log: `Successfully connected (transport: stdio)`, `negotiatedProtocolVersion: 2025-11-25`, `hasTools: true`.
   - It called `list` (limit 3), `replyFacts` (`<req@owner.example>`) and `verify`: all three `completed successfully`, no `is_error`, and its answer reported the right counts (3 records; 3 direct replies; `ok: false` for the unsigned record it picked).
   - No protocol error anywhere in the debug log. Claude Code ended the session by closing the pipe/SIGINT then SIGTERM; the server exited cleanly ("MCP server process exited cleanly").
3. Not tested against a real client: `isError` results and the -32xxx errors (only the scripted harness drove those); other clients (Claude Desktop, Cursor, Inspector).

## Measured (3 runs, shared box at load average 14-16; the first run under load 25 was 1.8 s / 10 s)

| | ms |
|---|---|
| spawn to `initialize` response (node start + importing the library) | 408-465 |
| `tools/list` | 0.4-0.6 |
| `list` (first call: builds the trail index) | 64-71 |
| `show` / `verify` | 1.5 / 2.1-2.4 |
| `counterparties` | 7-8 |
| `replyFacts` (first call: starts the worker thread) | 685-743 |

Size: `server.js` 120 lines (about 45 are the tool table).

## Findings and gaps

- Claude Code defers MCP tools behind its `ToolSearch` in `-p` mode; the model had to select them first. Nothing for the server to do.
- Claude Code tags every server stderr line `[ERROR]` in its debug log; keep stderr silent by default (it is).
- On shutdown Claude Code sent SIGINT and, after about 260 ms, SIGTERM; the server exited cleanly either way. `mp.close()` should stay fast (not measured separately).
- `replyFacts` costs about 0.7 s cold because `check`/`replyText` extraction runs in the warm worker. The real server should keep the worker (a long-lived process pays it once); `worker: { size: 0 }` would avoid it but drops the deadline backstop for untrusted mail, so do not.
- Protocol surface needed was small: no resources, prompts, sampling, logging, pagination or progress; `tools: { listChanged: false }` is enough. Supported versions are listed in one array; versions 2024-11-05 to 2025-11-25 differ for these methods only in optional fields (tool `title`, `structuredContent`, `outputSchema`), none required here.
- One source of truth: tool descriptions and schemas could be generated from the same JSDoc as the CLI help. `primitives.json` already carries `@when` (description), `@fails` and `@signature` per `Mailproof#method`, and `src/cli/commands.js` + `help.generated.js` already merge those with per-command flags (`flags` carry `type`, `arg`, `help`, and could yield `inputSchema.properties`). A `gen-mcp-tools` step, or a runtime read of `help.generated.js`, would give `description = when + fails` with the flag table as the schema, and a completeness test like the existing primitives one would keep them in step. Not built here.
- Tool output: the POC returns `JSON.stringify(result, null, 2)` as one text block. Untrusted mail fields therefore reach the model as data; the real server must say so in each description (the CLI's `printable()` is for terminals, not models).
