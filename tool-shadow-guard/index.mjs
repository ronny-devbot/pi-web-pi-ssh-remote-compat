// ~/.pi-web-pi-ssh-remote-compat/tool-shadow-guard/index.mjs (self-locating)
//
// Preload (NODE_OPTIONS="--import .../index.mjs", see ~/.profile) that stops
// pi-web's local wrappers of built-in tools from shadowing
// @99percentpeople/pi-ssh-remote's remote versions (all built-in names are filtered).
//
// Why: pi-web injects a custom `edit` tool (server-computed diff preview for
// the browser card) as a session custom tool. The SDK registry merges host
// custom tools AFTER extension tools (last wins), so that wrapper silently
// replaces ssh-remote's remote `edit` in SSH sessions: the model's `edit`
// resolves to a LOCAL file editor while the session is "remote" (verified:
// remote file created via remote bash -> edit -> local ENOENT). pi-web's other
// custom tools (spawn_session, ask_user, ...) have unique names and no remote
// counterpart, so they are harmless. To stay safe against pi-web adding more
// built-in wrappers (e.g. a local write), the filter covers ALL built-in tool
// names, not just 'edit'.
//
// How: this preload runs (synchronously) before the main module loads. It
// patches pi-web's 5-line SDK facade (dist/piSdk.js) IN PLACE so the
// session-creation exports filter built-in-named entries out of `customTools`. The
// The pristine file is kept as piSdk.js.bak next to THIS FILE (the guard is
// self-locating; EDIT_GUARD_DIR overrides). The patch is
// idempotent; a pi-web npm update replaces the file with the pristine
// version, and the next pi-web start re-patches it (or fails closed if the
// new file drifted).
//
// Fail-closed: if the facade is present but its structure no longer matches
// (drift), or the SELFTEST file is present, this preload THROWS before any
// module loads -> the pi-web process refuses to start. An unpatched
// (vulnerable) pi-web never serves silently.
//
// If you ever remove this guard, restore the pristine facade:
//   cp <this-dir>/piSdk.js.bak <pi-web>/dist/piSdk.js
//
// Self-test: touch <this-dir>/SELFTEST, start pi-web-sessiond,
// expect a failed unit with the FAIL-CLOSED error; rm the file, restart.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD_DIR = process.env["EDIT_GUARD_DIR"] ?? dirname(fileURLToPath(import.meta.url));
const SELFTEST = join(GUARD_DIR, "SELFTEST");
const BAK = join(GUARD_DIR, "piSdk.js.bak");
const DEBUG = process.env["EDIT_GUARD_DEBUG"] === "1";
const log = (...a) => { if (DEBUG) console.error("[tool-shadow-guard]", ...a); };

const MARKER = "__g_sdk"; // proves our patch is already in place

function failClosed(why) {
  throw new Error(
    `[tool-shadow-guard] FAIL-CLOSED: ${why}. Refusing to start so an unpatched ` +
    `pi-web (local wrappers shadowing remote tools) never serves silently. ` +
    `Re-verify the guard against the installed pi-web, or remove it only if ` +
    `you explicitly accept the local-tool shadowing.`
  );
}

// --- locate the facade -----------------------------------------------------
// nvm layout: <prefix>/bin/node with globals in <prefix>/lib/node_modules.
const candidates = [
  process.env["EDIT_GUARD_FACADE"], // test override
  join(dirname(dirname(process.execPath)), "lib", "node_modules", "@jmfederico/pi-web", "dist", "piSdk.js"),
  join(dirname(dirname(process.execPath)), "node_modules", "@jmfederico/pi-web", "dist", "piSdk.js"),
].filter(Boolean);

const facade = candidates.find((p) => existsSync(p));
if (!facade) {
  // pi-web not installed for this node: nothing to protect, stay idle.
  // (No process.exit here: a preload must never kill the host process.)
  log("no pi-web facade found for this node; guard idle");
} else if (existsSync(SELFTEST)) {
  failClosed("self-test requested (SELFTEST file present)");
} else {
  const src = readFileSync(facade, "utf8");

  // --- already patched (idempotent) ------------------------------------------
  if (src.includes(MARKER)) {
    // Steady state: the guard is in place; stay silent (EDIT_GUARD_DEBUG=1 for detail).
    log("already patched (steady state):", facade);
  } else {
    // --- canary: the file must match the expected pi-web facade shape -------
    const canary =
      src.includes('import { loadPiSdk } from "./piRuntime.js";') &&
      src.includes("const sdk = await loadPiSdk();") &&
      src.includes("createAgentSessionFromServices") &&
      (src.match(/await loadPiSdk\(\)/g) ?? []).length === 1;
    if (!canary)
      failClosed(`facade ${facade} no longer matches the expected pi-web layout (drift after an update?)`);

    // --- patch in place -------------------------------------------------------
    const patched = src.replace("const sdk = await loadPiSdk();", `const ${MARKER} = await loadPiSdk();
// >>> tool-shadow-guard: filter built-in-named entries out of pi-web's customTools so no
// >>> local wrapper can shadow an extension-registered remote version (ssh-remote
// >>> registers remote copies of the built-in file/shell tools). The list is the
// >>> SDK's built-in tool names - extend it if the SDK's set changes. Do not remove
// >>> without removing <this-dir>/index.mjs from NODE_OPTIONS.
const __g_filter = (o) => (o && Array.isArray(o.customTools)
  ? { ...o, customTools: o.customTools.filter((t) => !(t && ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"].includes(t.name))) }
  : o);
const sdk = {
  ...${MARKER},
  createAgentSession: (o) => ${MARKER}.createAgentSession(__g_filter(o)),
  createAgentSessionFromServices: (o) => ${MARKER}.createAgentSessionFromServices(__g_filter(o)),
  createAgentSessionRuntime: (r, o) => ${MARKER}.createAgentSessionRuntime(r, __g_filter(o)),
};
// <<< tool-shadow-guard`);
    if (patched === src)
      failClosed("transform reported success but changed nothing");

    writeFileSync(BAK, src); // pristine copy, for rollback
    writeFileSync(facade, patched);
    console.error(`[tool-shadow-guard] ACTIVE: patched ${facade} (pristine kept at ${BAK})`);
  }
}
