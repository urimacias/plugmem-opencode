# plugmem-opencode

Long-term memory for [OpenCode](https://opencode.ai) v2, backed by
[PlugMem](https://github.com/TIMAN-group/plugmem).

The plugin gives every OpenCode session a memory that survives restarts:

- **Recalls** relevant facts when a session starts and on substantial
  prompts, and injects them into the system prompt as a `<plugmem-memory>`
  block before the model is called.
- **Writes** only what is worth keeping. Writes pass a promotion gate:
  explicit corrections ("no, use pnpm") and failure→success pairs (a
  failing command followed by the fix) become semantic or procedural
  memories.
- **Isolates** memory per repository. Each git repo gets its own graph, so
  a Rails project does not inherit conventions from a Rust project.

The promotion gate and recall formatting come from
[`plugmem-coding-core`](https://github.com/TIMAN-group/plugmem), the same
harness-agnostic core used by the Claude Code adapter. This repository
vendors that core (Apache-2.0, see `NOTICE`) so the plugin is
self-contained.

## Requirements

- OpenCode 2.x (the v2 plugin API: `export default { id, setup }`).
- A running PlugMem service. Default endpoint:
  `http://127.0.0.1:18080`.
- An API key if the service requires one (`X-API-Key`).
- Node 20+ to build; the built `dist/` is what OpenCode loads.

## Install

### From a local checkout

```bash
git clone <this-repo> ~/dev/plugmem-opencode
cd ~/dev/plugmem-opencode
npm install
npm run build
```

Point OpenCode at the build. In `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/Users/you/dev/plugmem-opencode/dist/index.js"]
}
```

Or drop a loader in `~/.config/opencode/plugins/plugmem.ts` (auto-discovered):

```ts
export { default } from "/Users/you/dev/plugmem-opencode/dist/index.js";
```

### From npm (once published)

```jsonc
{
  "plugins": ["plugmem-opencode"]
}
```

Pass options either as an object entry:

```jsonc
{
  "plugins": [
    {
      "package": "/Users/you/dev/plugmem-opencode/dist/index.js",
      "options": { "baseUrl": "http://127.0.0.1:18080" }
    }
  ]
}
```

## Configure the API key

Do not put the key in a world-readable file. The plugin reads three
layers, highest precedence first:

1. Plugin options (`ctx.options`).
2. Environment variables.
3. `~/.config/opencode/plugmem.json`.

```bash
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/plugmem.json <<'JSON'
{
  "baseUrl": "http://127.0.0.1:18080",
  "apiKey": "your-key"
}
JSON
chmod 600 ~/.config/opencode/plugmem.json
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `PLUGMEM_BASE_URL` | Service base URL. `/api/v1` is appended automatically. |
| `PLUGMEM_API_KEY` | Value for `X-API-Key`. |
| `PLUGMEM_OPENCODE_DISABLED` | Set to `1` to turn the plugin off. |
| `PLUGMEM_OPENCODE_PLANNER` | Set to `1` to let the server run its LLM planner on recall. |
| `PLUGMEM_OPENCODE_CONFIG` | Alternate path for the JSON config file. |

## Options

All options are optional.

```jsonc
{
  "plugins": [
    {
      "package": "plugmem-opencode",
      "options": {
        "baseUrl": "http://127.0.0.1:18080",
        "apiKey": "...",
        "timeoutMs": 8000,
        "maxRetries": 1,
        "planner": false,
        "tools": true,
        "promoteOnIdle": true,
        "idleDebounceMs": 60000,
        "logLevel": "info",

        "sessionStartRecall": { "enabled": true, "charCap": 2000 },
        "userPromptRecall": { "enabled": true, "charCap": 1000, "minPromptLength": 30 },
        "toolFamilyRecall": { "enabled": false }
      }
    }
  ]
}
```

Set a recall trigger to `false` to disable it entirely.

The default `timeoutMs` is deliberately short (8 s) and `maxRetries` low:
memory must never stall a turn. Every hook is wrapped, so an outage
degrades to "no memory" rather than a broken session.

### Fast recall: `planner: false`

PlugMem's `/retrieve` runs an LLM planner by default. That costs a full
generation per recall: measured at ~43 s on a free-tier model, versus
~80 ms with the planner off. The plugin therefore sends
`auto_plan: false`.

Servers that predate the `auto_plan` field ignore it (Pydantic drops
unknown fields), so this stays compatible — but on such servers recall
runs slowly and may hit `timeoutMs`. If you cannot patch the server, set
`"planner": true` and a larger `"timeoutMs"` to keep the old behaviour.

The two-line server change:

```python
# plugmem/api/schemas.py — RetrieveRequest
auto_plan: bool = True

# plugmem/api/routes/retrieval.py — retrieve()
auto_plan=body.auto_plan,   # was: auto_plan=True
```

Default `True` keeps existing clients unchanged; the plugin opts out.

### Tool-family recall

Optional pre-tool recall. Off by default because it adds a round trip
before each matching tool call.

```jsonc
{
  "toolFamilyRecall": {
    "enabled": true,
    "mapping": {
      "pytest|vitest|npm test": "test conventions, flaky tests, fixtures",
      "docker|compose": "container setup, ports, volumes"
    }
  }
}
```

## How it hooks into OpenCode v2

| Hook | What it does |
| --- | --- |
| `session.hook("prompt")` | Records the prompt for promotion; recalls on substantial prompts. |
| `session.hook("context")` | First call per session does the session-start recall. Then injects any recalled blocks into `system` before dispatch and schedules promotion. |
| `session.hook("compaction")` | Flushes candidates before the transcript is summarised, then re-recalls for the compacted context. |
| `tool.hook("execute.before")` | Records the tool call (failure tracking). |
| `tool.hook("execute.after")` | Marks success/failure from the exact tool status; a failure followed by a success inside 10 minutes becomes a candidate. |
| `tool.transform` | Registers `plugmem_recall` and `plugmem_remember`. |

Promotion runs off the request path: `/extract` is an LLM call, so it is
debounced and limited to one in flight per session.

## Tools

When `tools` is not `false`, the plugin registers two tools:

- `plugmem_recall({ query, graph? })` — search memory. Defaults to this
  repository's graph.
- `plugmem_remember({ text, kind?, tags?, graph? })` — store a fact
  (`kind: "semantic"`, default) or a procedure (`kind: "procedural"`).
  Writes immediately, bypassing the promotion gate.

If you already expose PlugMem through MCP, these overlap; set
`"tools": false` and keep the MCP surface only.

## How memory is scoped

The core derives `repo://opencode/<host>/<owner>/<repo>`, but PlugMem only
accepts graph names matching `[a-zA-Z0-9._-]{3,512}`. The vendored core
renders the same identity in a legal form:

```
repo.opencode.github.com.owner.repo      # git remote present
repo.opencode.local.<sha256:16>          # no remote (path hashed)
```

Memories do not flow between harnesses: a Claude Code session and an
OpenCode session on the same repository use different graphs by design.

## Costs and privacy

- Recall is a vector query (`/retrieve`) when the planner is off, not an
  LLM call. It is cheap and fast.
- Writing uses `/extract`, which calls an LLM. It runs only when the
  promotion gate has candidates, not on every turn.
- Everything stays on the PlugMem instance you configure. Pointing the
  plugin at a remote instance sends prompts and tool results there.
- Tool output is truncated to 4 000 characters before it enters the
  promotion pipeline.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

To refresh the vendored core from a local PlugMem checkout:

```bash
PLUGMEM_SRC=~/dev/PlugMem/plugmem-coding-core/src npm run sync-core
```

Re-apply the two local patches listed in `NOTICE` after syncing.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
