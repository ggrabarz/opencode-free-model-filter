# opencode-free-model-filter

OpenCode plugin that hides every paid model by default and turns **Ctrl+L** in
the built-in **Select model** dialog into a toggle between the free-only and
paid-only lists.

- Default catalog: free models only.
- `Ctrl+L` in the model picker: show paid models only.
- `Ctrl+L` again: back to free models only.
- Free and paid **auto routers** are classified by their own cost entry, so a
  free router (`openrouter/free`, `freellmapi/auto`) is in the free list and a
  priced router (`openrouter/auto` at a non-zero price) is in the paid list.
- The real picker is kept: search, favorites, recents, provider groups, model
  variants and selection all keep working.

## Install

The plugin has two halves and a local install needs both:

1. **Server half** — filters the catalog and serves the toggle RPC. Copy or
   junction this repository into the server's local plugin directory:

   ```powershell
   cmd /c mklink /J "$env:USERPROFILE\.config\opencode\plugins\free-model-filter" "C:\dev\opencode\workspace-8\opencode-free-model-filter"
   ```

   (A plain copy of the repository also works; the junction just keeps the
   working tree live.)

2. **TUI half** — binds Ctrl+L in the model dialog. Add the package to
   `~/.config/opencode/cli.json`:

   ```json
   {
     "plugins": [
       { "package": "C:\\dev\\opencode\\workspace-8\\opencode-free-model-filter" }
     ]
   }
   ```

Restart OpenCode (or start a new session) and open **Select model**. Paid
models are gone from the list.

## Usage

| Where | Key | Result |
| --- | --- | --- |
| Select model dialog | `Ctrl+L` | Switch to the other bucket and show a toast |
| Anywhere else | `Ctrl+L` | Unchanged; the plugin's binding only exists in dialogs |

The mode is runtime state for the current server location. A fresh server (or
a restart) always starts in **free** mode, which is the default you asked for.

## What counts as free?

The rule is deliberately explicit and conservative:

1. **Explicit cost wins.** If the model has a non-empty `cost` array, every
   entry must have `input === 0` and `output === 0`. Cache prices are ignored.
   A non-zero entry means paid.
2. **Empty or missing cost** is free only when the provider is known to be free:
   - a local/private base URL: `localhost`, `*.localhost`, `127.0.0.0/8`,
     `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`,
     `::1`, `0.0.0.0`, `host.docker.internal`;
   - the provider id is in `freeProviders` (defaults: `freellmapi`,
     `freellmapi-anthropic`, `logfare`), or the provider id/name contains
     `free`;
   - the model id ends in `:free` / `-free`, or the name contains `(free)` or
     the word `free`.
3. **Unknown cost on a remote provider is paid.** This is what keeps mixed
   gateways such as `xkiro` (108 models with `cost: []`, only 47 free) from
   leaking paid models into the default list. Those free models are hidden too
   until the provider declares a cost or you add it to `freeProviders`.

`freeProviders` can be extended without editing code with a comma-separated
environment variable on the server:

```powershell
$env:OPENCODE_FREE_MODEL_FILTER_PROVIDERS = "my-gateway,another-free-gateway"
```

The server plugin also accepts plugin options `freeProviders: string[]` and
`defaultMode: "free" | "paid" | "all"` when it is loaded as a configured
package. Local directory discovery has no options; the environment variable is
the simple path.

## How it works

The built-in model dialog has no plugin hook for its list and no plugin API for
selecting a model, so the plugin does **not** replace it. Instead:

- The server half registers a replayable `ctx.model.transform` that sets
  `enabled = false` on every model outside the active bucket. Transforms are
  rebuilt from the untouched catalog on every read, so flipping the bucket is
  reversible and a toggle never accumulates state.
- The TUI half registers `Ctrl+L` in keymap mode `modal`, which OpenCode's
  dialog stack activates. The layer is also limited to a focused list-filter
  input, so the key stays inert in alerts, confirms and prompts.
- The TUI half calls the location-scoped RPC `free-model-filter/toggle`. The
  server updates the mode, calls `ctx.model.reload()`, and OpenCode publishes
  `model.updated`; the open picker refreshes in place.
- Models outside the bucket are only disabled, never removed, and the original
  `enabled` value comes from the catalog on every replay. Toggling back restores
  the exact free list, including models the user disabled themselves.

## Tests

```powershell
bun install
bun test
```

The suite has three layers:

- `test/classify.test.ts` — 40 unit tests for every classifier branch,
  including explicit zero cost, empty cost, local URLs, free markers, and free
  and paid auto routers.
- `test/server.e2e.test.ts` — starts the real `opencode serve` with an isolated
  config/project, waits for the plugin to activate, and asserts the real
  `/api/model` endpoint returns exactly the free fixture models, that toggling
  via the real `POST /api/rpc/free-model-filter/toggle` returns paid-only, that
  `model.updated` is published, and that toggling back restores the free list.
- `test/tui.e2e.test.tsx` — drives the installed OpenCode TUI through a Windows
  ConPTY: opens the real **Select model** dialog, verifies the exact free rows,
  presses Ctrl+L twice, verifies paid-only rows, closes/reopens the dialog to
  check mode persistence, verifies Ctrl+L is inert outside the dialog, and
  selects a model through the picker.

The e2e tests use the installed CLI. Set `OPENCODE_BIN` to another executable to
run them against a different build. They create a temp config/project with a
directory junction to this repository, so they never read or write your live
OpenCode state.

## Limitations

- Cost is only as good as the catalog. A provider that reports `cost: []` for a
  mix of free and paid models is treated as paid; add it to `freeProviders`
  only if every model behind it is genuinely free.
- The toggle is per server location and resets to free on restart by design.
- Replacing the picker was rejected on purpose: model selection is not exposed
  to plugins, and a custom dialog could not select a model reliably on the
  home/new-session route.

## License

MIT
