# pi-ssh-remote-inherit

Bridges [`pi-ssh-remote`](https://github.com/99percentpeople/pi-extensions)'s per-session SSH state into pi-web's **inheritable session state** (`pi-web.session-state` custom entries with `inherit: true`), so sessions spawned with `spawn_session` / `spawn_subsession` inherit the spawner's active SSH workspace.

## How it works

- **Parent side** — when pi-ssh-remote changes the environment (`ssh-remote:environment` events: connect, cd, exit) or on session start/resume, the latest `pi-ssh-remote-state` / `pi-ssh-local-state` entry is mirrored into a `pi-web.session-state` entry under namespace `ssh-remote` (`inherit: true`). Latest-wins, so exit-after-connect correctly mirrors "local".
- **Child side** — pi-web ≥ 1.202611.3 seeds `inherit: true` entries into spawned session files at spawn time. On `session_start`, this extension re-appends the seeded value as a regular `pi-ssh-remote-state` (or `pi-ssh-local-state`) entry, which pi-ssh-remote's own `session_start` handler then restores (reconnects).

On older pi-web versions the entries are inert: nothing reads them and children start local. No misrouting, ever — the failure mode is "child starts local".

## Install

```sh
pi install git:github.com/ronny-devbot/pi-ssh-remote-inherit
```

## Ordering requirement

This package must **load before** `pi-ssh-remote`, or the child-side adoption misses the `session_start` window. Load order = project `.pi/settings.json` `packages` (array order), then user `~/.pi/agent/settings.json` `packages` (array order).

The extension checks this itself at `session_start` and shows a warning naming the offending entry and file until you fix it. If either package's install source is not recognizable, it stays silent.

## Limitations

- A transport drop that pi-ssh-remote handles internally (no `succeeded` environment event) is not mirrored until the next event or turn end.
- Inheritance reflects the spawner's state **at spawn time** (that is what pi-web's mechanism does for all session state).
- One namespace (`ssh-remote`), latest entry wins; state is capped at pi-web's 64 KB session-state limit.

## Test

```sh
node test.mjs
```
