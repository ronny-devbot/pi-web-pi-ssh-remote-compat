# tool-shadow-guard

A ~90-line Node preload that stops **pi-web's local wrappers of built-in tools from
shadowing `@99percentpeople/pi-ssh-remote`'s remote versions** — a hole where the
model's `edit` tool resolved to a **local file editor while the session was "remote"**.
The filter covers *all* built-in tool names, so a future pi-web wrapper (e.g. a local
`write`) is blocked without code changes.

No dependencies. One file. One line in `~/.profile`. Fails closed.

## The bug this guards against

pi-web injects a custom `edit` tool into every session (a server-computed diff preview
for the browser card; `dist/server/sessions/piSessionService.js` →
`createPiWebCustomToolDefinitions`). The Pi SDK merges host custom tools **after**
extension tools, last one wins (`dist/core/agent-session.js` → `_refreshToolRegistry`).
So in an SSH session, ssh-remote's remote `edit` (an extension tool) is silently
replaced by pi-web's local wrapper (a custom tool).

Verified before the fix (probe on a remote host):

```
bash  (remote): echo X > /tmp/probe.txt        # file exists on the remote
edit  (tool):   edit /tmp/probe.txt            # -> "Error code: ENOENT"  (looked LOCAL)
bash  (remote): cat /tmp/probe.txt             # unchanged — nothing was edited
```

`read`, `write`, `bash`, `grep`, `find`, `ls` are unaffected **today** (pi-web only
wraps `edit`); the filter is generalized to all built-in names so a future wrapper is
caught. The fix belongs in pi-web (the wrapper should not override an extension-provided
tool of the same name, or should compute the preview against the active implementation) —
this guard is the local, version-pinning stopgap until upstream fixes it.

## How it works

The preload (`index.mjs`, loaded via `NODE_OPTIONS=--import`) runs **synchronously
before the main module loads** and patches pi-web's 5-line SDK facade
(`dist/piSdk.js`) **in place**: the session-creation exports
(`createAgentSession`, `createAgentSessionFromServices`, `createAgentSessionRuntime`)
are wrapped to filter all built-in-named entries out of `customTools` (the list lives
in `index.mjs`).

State machine at process start:

| Facade state | Behavior |
|---|---|
| not found for this node | silent, process continues (guard idle) |
| already patched (marker `__g_sdk`) | silent, process continues (steady state) |
| pristine + canary matches | **patch in place**; pristine kept next to `index.mjs` (`piSdk.js.bak`; `EDIT_GUARD_DIR` overrides); banner `ACTIVE: patched …` on stderr |
| present but drifted (canary fails) | **throw → process refuses to start (FAIL-CLOSED)** |
| `SELFTEST` file present | **throw → FAIL-CLOSED** (proves the alarm works) |

Fail-closed means: an unpatched (vulnerable) pi-web **never serves silently**. The
dangerous state is un-runnable — you either get the banner, or a loudly failed unit.

Design notes (why this shape):

- **In-place file patch, not a module loader hook.** Node 26's synchronous
  `module.registerHooks` is broken for pass-through `load` hooks (returning
  `undefined`/`null` crashes the loader; `shortCircuit: false` is rejected), and
  async `module.register` has a startup race (hooks thread may not be ready when the
  main module loads → silently unpatched). Patching the file before anything imports
  it is deterministic and trivially inspectable (`cat dist/piSdk.js` shows the patch).
- **Carried by `~/.profile`, not the systemd unit.** `pi-web update` leaves units
  alone but `pi-web install` **overwrites them unconditionally**
  (`installSystemdServices` does a blind `writeFile`). The pi-web services run via
  `bash -lc`, which reads `~/.profile` — a file pi-web never touches. A unit
  `Environment=` line would be a second carrier that `pi-web install` wipes; the
  profile line alone is sufficient and survives everything.
- **No `process.exit()` in the preload.** A `--import` preload that calls
  `process.exit(0)` kills the host process before the main module runs (the daemon
  "exits successfully" and stays dead, because `Restart=on-failure` doesn't fire on
  exit 0). The preload must only ever *return* (or throw, deliberately).

## Setup

### 1. Install the guard

```sh
# deployed as the monorepo clone (this folder is a top-level dir of it):
git clone github.com/ronny-devbot/pi-web-pi-ssh-remote-compat ~/.pi-web-pi-ssh-remote-compat
```

The guard is **self-locating**: backup and self-test files live next to `index.mjs`
(`EDIT_GUARD_DIR` overrides). It locates the facade at
`<node prefix>/lib/node_modules/@jmfederico/pi-web/dist/piSdk.js` (nvm layout) for
whatever node the pi-web services run on; if your pi-web lives elsewhere, extend the
`candidates` list in `index.mjs` (or point `EDIT_GUARD_FACADE` at it — that override is
intended for testing).

### 2. Add the carrier line to `~/.profile`

(Back it up first: `cp ~/.profile ~/.profile.bak-editguard`.) If you have a
`~/.bash_profile`/`~/.bash_login`, put it there instead (login shells read that first).

```sh
# --- pi-web/pi-ssh-remote compat guard (do not remove while using pi-web + ssh-remote) ---
export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--import /home/<you>/.pi-web-pi-ssh-remote-compat/tool-shadow-guard/index.mjs"
```

This is inherited by every node process started from a login shell — including the
pi-web services (`bash -lc`). Plain node processes are unaffected in practice: the
guard stays silent and lets them run (it only acts on the pi-web facade).

### 3. Restart the pi-web services

```sh
systemctl --user restart pi-web.service
systemctl --user restart pi-web-sessiond
```

(If both are restarted, gateway first — as above.)

### 4. Verify

```sh
# 1. Daemon healthy
systemctl --user is-active pi-web-sessiond          # -> active

# 2. Guard loaded in the daemon
tr '\0' '\n' < /proc/$(systemctl --user show -p MainPID --value pi-web-sessiond)/environ \
  | grep NODE_OPTIONS

# 3. Facade actually patched
grep -c "__g_sdk" ~/.nvm/.../lib/node_modules/@jmfederico/pi-web/dist/piSdk.js   # > 0

# 4. Behavior (the real test): in a pi-web SSH session,
#    create a file with the remote bash tool, then edit it with the edit tool.
#    Before the guard: ENOENT (local). After: the edit lands on the remote.
```

## Self-test (prove the alarm before trusting it)

```sh
touch ~/.pi-web-pi-ssh-remote-compat/tool-shadow-guard/SELFTEST
systemctl --user restart pi-web-sessiond     # must END UP FAILED with the FAIL-CLOSED error
journalctl --user -u pi-web-sessiond -n 20   # -> [tool-shadow-guard] FAIL-CLOSED: self-test requested …
rm ~/.pi-web-pi-ssh-remote-compat/tool-shadow-guard/SELFTEST
systemctl --user restart pi-web-sessiond     # healthy again
```

`EDIT_GUARD_DEBUG=1` prints the guard's decisions (which branch it took).
`EDIT_GUARD_FACADE=/path` points the canary at a copy — use a mutated copy to
exercise the drift path without touching the real file.

## Interaction with pi-web's lifecycle

| pi-web event | Effect on the guard |
|---|---|
| `pi-web update` (npm) | Replaces `dist/piSdk.js` with the pristine version. Next pi-web start: guard re-patches it (banner) **or fails closed loudly** if the new file's shape drifted. Nothing to do, ever. |
| `pi-web install` | Overwrites the **systemd units** (blind `writeFile`). The profile line and guard are untouched. |
| `pi-web uninstall` | Removes units; guard stays (idle until pi-web is reinstalled). |

## Removal / rollback

```sh
# 1. Restore the pristine facade (the patch is on disk until an npm update replaces it)
cp ~/.pi-web-pi-ssh-remote-compat/tool-shadow-guard/piSdk.js.bak <pi-web>/dist/piSdk.js
# 2. Remove the export line from ~/.profile
# 3. Restart both pi-web services
```

## Scope — what this does NOT protect against

- **Other packages registering built-in tool names** (a local `bash`/`read`/… from any
  package would also shadow the remote versions): detected by the `lockdown-checker`'s
  tool-shadowing scan, not by this guard.
- **Local sessions**: a model in a local session has local tools by definition; no
  settings-level fix exists without also killing remote tools (shared tool names).
- **`send_session_message`**: set `"sessionMessages": false` in
  `~/.config/pi-web/config.json` — that's the lever for cross-session steering.
- **Local reads of skill files** (ssh-remote routes skill-directory reads locally by
  design) and **compaction persisting injected text** — small, separate items.
- **Browser-side pi-web features** (terminal, attachments, config UI) — trusted-user
  territory, out of scope for a compromised-model threat model.
