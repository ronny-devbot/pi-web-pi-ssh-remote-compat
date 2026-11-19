# lockdown-checker

`check-lockdown.mjs` — a **read-only audit** of the SSH-session lockdown. It inspects
the settings **current on execution** (never assumptions) and lists what to rectify.
It changes nothing.

```sh
node <path-to>/check-lockdown.mjs
# exit 0 = clean, 1 = problems found, 2 = warnings only (incl. unreviewed packages)
```

## What it checks

1. **Guard wiring** — `tool-shadow-guard/index.mjs` present; `~/.profile` `NODE_OPTIONS`
   carrier (incl. `~/.bash_profile` shadow detection); facade patch state (patched /
   pristine-but-compatible / drifted→will-fail-closed); `.bak` rollback copy; no stray
   `SELFTEST`; daemon active **and** guard actually in its `/proc` environ.
2. **pi-web config** — effective values incl. defaults: `sessionMessages` (cross-session
   steering hole), `spawnSessions`/`subsessions` (safe while children inherit state),
   `relays` (human-gated), `askUser`, `workspace-tasks`.
3. **Pi agent settings** — `ssh-remote.aiControlTools` (model state-shedding), required
   packages present (ssh-remote + glue), per-package verdicts (below), `defaultTools`
   (`powershell` is never remote-routed), `mcp.json` (global + every trusted project).
4. **Tool shadowing (drift check)** — re-derives the name-collision set from the code
   installed *right now*: which built-in tools the installed pi-web wraps locally, whether
   the guard's filter covers them, and whether any other installed package registers a
   built-in name (best-effort: literal registrations only).
5. **Optional defense-in-depth** — sandbox state.
6. **Accepted by design** — printed so they never surprise you later (local-zone tools,
   skill-directory reads).

Every problem line carries the exact fix (file + change).

## `known-packages.json` — the verdict table

One entry per package id (as listed in `~/.pi/agent/settings.json` `packages`):

- `safe:` — reviewed, no local-access hole in SSH sessions
- `warn:` — known trade-off, flagged as warning
- `problem:` — known hole, flagged as problem
- `pi-web-bundled` — class verdict for any path under pi-web's `dist/pi-packages/`

**Anything not listed is reported as `UNREVIEWED` (warning).** Reviewing a new install
means deciding one of the three verdicts and adding a line here — that is the maintenance
contract: a new package is a new surface until it has a verdict.

## Test overrides

`CHECK_LOCKDOWN_AGENT_SETTINGS`, `CHECK_LOCKDOWN_SHARED_SETTINGS`,
`CHECK_LOCKDOWN_PIWEB_CONFIG`, `CHECK_LOCKDOWN_TRUST`, `CHECK_LOCKDOWN_KNOWN_PACKAGES`
point the checker at alternative files (used to test the unreviewed/problem paths).
