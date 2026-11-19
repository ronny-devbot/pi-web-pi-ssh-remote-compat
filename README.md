# pi-web-pi-ssh-remote-compat

Compatibility layer between **pi-web** and **@99percentpeople/pi-ssh-remote**: keeps
SSH (remote-work) sessions locked down from local file access.

## Layout

- `pi-web-edit-guard/` — the core fix. A small Node preload (wired via
  `~/.profile` `NODE_OPTIONS`) that stops pi-web's local `edit` wrapper from
  shadowing ssh-remote's remote `edit`. Fails closed: if it cannot be applied
  (pi-web drift), the daemon refuses to start. See its README for bug, design,
  self-test and rollback.
- `lockdown-checker/` — `check-lockdown.mjs`, a read-only audit of the whole
  lockdown using the settings current on execution (guard wiring, pi-web config,
  agent settings, packages, MCP). Exit 0/1/2 = clean / problems / warnings.
  `known-packages.json` holds per-package verdicts; unlisted packages are flagged
  unreviewed.

## Status

Experimental reorganization, decomposed from `github.com/ronny-devbot/pi-web-edit-guard`
(kept intact until this layout is approved).
