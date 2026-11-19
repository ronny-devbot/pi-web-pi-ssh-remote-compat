#!/usr/bin/env node
// ~/.pi-web-pi-ssh-remote-compat/lockdown-checker/check-lockdown.mjs
//
// Checks that SSH (remote-work) sessions are locked down, using the SETTINGS
// CURRENT ON EXECUTION. Read-only: it changes nothing.
//
//   node ~/.pi-web-pi-ssh-remote-compat/lockdown-checker/check-lockdown.mjs
//   exit 0 = clean, 1 = problems found, 2 = warnings only
//
// Threat model: compromised LLM (user is trusted). Scope: a session that is
// connected to an SSH remote must not reach local files. Local sessions are a
// trusted-model zone by design (see NOTES at the end) and are not counted as
// problems.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HOME = os.homedir();
const GUARD_DIR = join(HOME, ".pi-web-pi-ssh-remote-compat", "tool-shadow-guard");
const GUARD = join(GUARD_DIR, "index.mjs");
const BAK = join(GUARD_DIR, "piSdk.js.bak");
const SELFTEST = join(GUARD_DIR, "SELFTEST");
const KNOWN_PACKAGES = process.env["CHECK_LOCKDOWN_KNOWN_PACKAGES"] ?? join(dirname(fileURLToPath(import.meta.url)), "known-packages.json");
const PIWEB_CONFIG = process.env["CHECK_LOCKDOWN_PIWEB_CONFIG"] ?? join(HOME, ".config", "pi-web", "config.json");
const AGENT_DIR = join(HOME, ".pi", "agent");
const AGENT_SETTINGS = process.env["CHECK_LOCKDOWN_AGENT_SETTINGS"] ?? join(AGENT_DIR, "settings.json");
const SHARED_SETTINGS = process.env["CHECK_LOCKDOWN_SHARED_SETTINGS"] ?? join(AGENT_DIR, "99extensions.json");
const SANDBOX = join(AGENT_DIR, "sandbox.json");
const TRUST = process.env["CHECK_LOCKDOWN_TRUST"] ?? join(AGENT_DIR, "trust.json");
const FACADE_CANDIDATES = [
  join(dirname(dirname(process.execPath)), "lib", "node_modules", "@jmfederico/pi-web", "dist", "piSdk.js"),
  join(dirname(dirname(process.execPath)), "node_modules", "@jmfederico/pi-web", "dist", "piSdk.js"),
];

const problems = [];
const warnings = [];
const notes = [];
const ok = (s) => console.log(`  [OK]      ${s}`);
const problem = (s, fix) => { problems.push(s); console.log(`  [PROBLEM] ${s}`); if (fix) console.log(`            fix: ${fix}`); };
const warn = (s, fix) => { warnings.push(s); console.log(`  [WARNING] ${s}`); if (fix) console.log(`            fix: ${fix}`); };
const note = (s) => { notes.push(s); console.log(`  [NOTE]    ${s}`); };

const readJson = (p) => {
  try { return { value: JSON.parse(readFileSync(p, "utf8")), text: readFileSync(p, "utf8") }; }
  catch { return { value: undefined, text: undefined, error: true }; }
};

// Resolve a packages[] entry to its on-disk directory (npm:/git:/absolute/relative).
const pkgDir = (id) => {
  const x = String(id);
  if (x.startsWith("npm:")) return join(HOME, ".pi", "agent", "npm", "node_modules", x.slice(4));
  if (x.startsWith("git:")) return join(HOME, ".pi", "agent", "git", x.slice(4));
  return x.startsWith("/") ? x : resolve(AGENT_DIR, x);
};

console.log(`SSH-session lockdown check — ${new Date().toISOString()}`);

// ---------------------------------------------------------------- the guard
console.log("Guard (tool-shadowing fix):");
if (!existsSync(GUARD))
  problem("guard file missing", `restore ${GUARD} (see its git history / this directory's docs)`);
else {
  ok(`guard file present: ${GUARD}`);
  const profile = readFileSync(join(HOME, ".profile"), "utf8");
  if (profile.includes(`--import ${GUARD}`) && profile.includes("NODE_OPTIONS"))
    ok("profile carrier: NODE_OPTIONS line present in ~/.profile");
  else
    problem("profile carrier missing: ~/.profile has no NODE_OPTIONS=…--import line for the guard",
      `append: export NODE_OPTIONS="\${NODE_OPTIONS:+\${NODE_OPTIONS} }--import ${GUARD}"`);
  if (existsSync(join(HOME, ".bash_profile")) || existsSync(join(HOME, ".bash_login")))
    problem("~/.bash_profile or ~/.bash_login exists — login shells (bash -lc, as used by the pi-web services) will NOT read ~/.profile, so the guard never loads",
      "move the NODE_OPTIONS export into that file, or remove the shadowing file");
  if (existsSync(SELFTEST))
    problem("SELFTEST file present — the daemon will refuse to start (fail-closed by design)", `rm ${SELFTEST}`);
  if (existsSync(BAK)) ok(`pristine facade backup present: ${BAK}`);
  else warn("pristine facade backup missing — rollback of a patch is not possible", "keep a copy of the original piSdk.js at " + BAK);

  const facade = FACADE_CANDIDATES.find(existsSync);
  if (!facade)
    warn("pi-web facade not found for this node — cannot verify patch state (is pi-web installed under this node?)");
  else {
    const src = readFileSync(facade, "utf8");
    if (src.includes("__g_sdk"))
      ok(`facade patched (guard in place): ${facade}`);
    else {
      const canary =
        src.includes('import { loadPiSdk } from "./piRuntime.js";') &&
        src.includes("const sdk = await loadPiSdk();") &&
        src.includes("createAgentSessionFromServices") &&
        (src.match(/await loadPiSdk\(\)/g) ?? []).length === 1;
      if (canary)
        ok("facade pristine but guard-compatible — will be patched automatically at next daemon start");
      else
        problem("facade drifted from the guard's expected layout — the daemon will FAIL CLOSED on next start (refuse to serve)",
          "re-verify/adjust the guard's canary + transform for the new pi-web version");
    }
  }

  // running daemon: active + guard env actually loaded
  try {
    const state = execSync("systemctl --user is-active pi-web-sessiond", { encoding: "utf8" }).trim();
    if (state !== "active")
      problem(`pi-web-sessiond is '${state}' — sessions are not being served (if the journal shows FAIL-CLOSED, the guard fired: fix the drift above)`,
        "journalctl --user -u pi-web-sessiond -n 50");
    else {
      ok("pi-web-sessiond active");
      const mpid = execSync("systemctl --user show -p MainPID --value pi-web-sessiond", { encoding: "utf8" }).trim();
      const environ = readFileSync(`/proc/${mpid}/environ`, "utf8");
      if (environ.includes(`NODE_OPTIONS=--import ${GUARD}`))
        ok("daemon process has the guard loaded (NODE_OPTIONS verified in /proc environ)");
      else if (environ.includes("NODE_OPTIONS="))
        problem("daemon's NODE_OPTIONS points at a different guard path (stale after a move/rename) — the loaded guard is not the deployed one",
          "systemctl --user restart pi-web-sessiond");
      else
        problem("daemon is running WITHOUT the guard (no NODE_OPTIONS in its environment) — it was started before the profile line was added",
          "systemctl --user restart pi-web-sessiond");
    }
  } catch {
    warn("could not query systemd state (no user bus in this shell?) — daemon status unverified");
  }
}

// ------------------------------------------------------------- pi-web config
console.log("pi-web config (effective values, incl. defaults):");
{
  const { value: cfg, error } = readJson(PIWEB_CONFIG);
  if (error)
    problem("pi-web config missing or unparseable", `check ${PIWEB_CONFIG}`);
  else {
    const spawnSessions = cfg.spawnSessions ?? true;
    const sessionMessages = cfg.sessionMessages ?? true;
    const subsessions = cfg.subsessions ?? true;
    const askUser = cfg.askUser ?? true;
    const plugins = cfg.plugins ?? {};
    const relays = plugins.relays?.enabled ?? true;
    const workspaceTasks = plugins["workspace-tasks"]?.enabled ?? true;

    if (sessionMessages)
      problem("sessionMessages: " + (cfg.sessionMessages === undefined ? "missing (defaults to TRUE)" : "true") +
        " → send_session_message is active: a compromised model can steer ANY session in the project, including idle LOCAL sessions → full local machine",
        `set "sessionMessages": false in ${PIWEB_CONFIG}`);
    else ok("sessionMessages: false (no cross-session steering)");

    const childTools = [
      ["spawnSessions", spawnSessions, "spawn_session"],
      ["subsessions", subsessions, "spawn_subsession + subsession tools"],
    ];
    for (const [key, val, what] of childTools)
      val ? ok(`${key}: true → ${what} (safe: children of connected sessions inherit remote state via the glue)`)
          : note(`${key}: false → ${what} unavailable`);
    askUser ? note("askUser: true (harmless — question UI, no file access)") : note("askUser: false");
    relays ? ok("plugins.relays: true (safe: dispatch requires explicit human approval; legs inherit state)")
           : note("plugins.relays: false");
    workspaceTasks ? note("plugins.workspace-tasks: true (browser/UI feature; model-facing bg tools only exist if the pi-background-tasks package is installed — see packages)")
                   : note("plugins.workspace-tasks: false");
  }
}

// ----------------------------------------------------------- pi agent settings
console.log("Pi agent settings:");
{
  const { value: shared } = readJson(SHARED_SETTINGS);
  const aiControl = shared?.["ssh-remote"]?.aiControlTools;
  if (aiControl !== false)
    problem(`ssh-remote.aiControlTools: ${aiControl === undefined ? "missing (check the extension default)" : "true"} in ${SHARED_SETTINGS}` +
      " → the model gets ssh_exit/ssh_connect: it can shed the SSH state mid-session (→ all tools go local); a failed ssh_connect also auto-returns to local",
      `set "ssh-remote": {"aiControlTools": false} in ${SHARED_SETTINGS}`);
  else ok("ssh-remote.aiControlTools: false (model cannot shed the SSH state)");

  const { value: settings } = readJson(AGENT_SETTINGS);
  const packages = settings?.packages ?? [];
  const has = (s) => packages.some((p) => String(p).includes(s));

  // Required packages (the lockdown depends on them).
  if (has("@99percentpeople/pi-ssh-remote")) ok("package present: @99percentpeople/pi-ssh-remote (required)");
  else problem("package missing: @99percentpeople/pi-ssh-remote", "pi install npm:@99percentpeople/pi-ssh-remote");
  {
    const glueEntries = packages.filter((p) => String(p).includes("pi-ssh-remote-inherit"));
    if (!glueEntries.length)
      problem("package missing: pi-ssh-remote-inherit glue — children of connected sessions would NOT inherit remote state (local access via spawned sessions)",
        "point packages at the glue folder of the deployment (e.g. /home/ronny/.pi-web-pi-ssh-remote-compat/pi-ssh-remote-inherit), listed BEFORE pi-ssh-remote");
    else {
      const glueDir = pkgDir(glueEntries[0]);
      if (!existsSync(glueDir))
        problem(`glue entry points to a MISSING directory: ${glueDir} — the glue would not load; children of connected sessions would start LOCAL instead of remote`,
          "restore the deployment clone (git clone github.com/ronny-devbot/pi-web-pi-ssh-remote-compat ~/.pi-web-pi-ssh-remote-compat) or fix the path in settings.json");
      else if (!existsSync(join(glueDir, "index.ts")) && !existsSync(join(glueDir, "index.js")))
        problem(`glue entry point missing in ${glueDir} (no index.ts/index.js) — the glue would not load`,
          "restore the pi-ssh-remote-inherit folder from the pi-web-pi-ssh-remote-compat repo");
      else {
        const gi = packages.findIndex((p) => String(p).includes("pi-ssh-remote-inherit"));
        const si = packages.findIndex((p) => String(p).includes("@99percentpeople/pi-ssh-remote"));
        if (si === -1 || gi < si)
          ok(`glue resolvable (${glueDir}), entry point present, listed before pi-ssh-remote (load order OK)`);
        else
          problem("glue is listed AFTER pi-ssh-remote in packages — it loses the session_start race; children of connected sessions would start LOCAL instead of remote",
            "move the pi-ssh-remote-inherit entry BEFORE the @99percentpeople/pi-ssh-remote entry in settings.json");
      }
    }
  }

  // Every other package: verdict from the allowlist; unlisted = UNREVIEWED.
  const { value: allow, error: allowErr } = readJson(KNOWN_PACKAGES);
  if (allowErr)
    warn(`package allowlist missing/unparseable: ${KNOWN_PACKAGES} — all packages below are treated as unreviewed`);
  const verdictFor = (id) => {
    const table = allow?.packages ?? {};
    if (table[id]) return table[id];
    if (String(id).includes("/pi-web/dist/pi-packages/") && table["pi-web-bundled"]) return table["pi-web-bundled"];
    return undefined;
  };
  for (const id of packages) {
    if (String(id).includes("@99percentpeople/pi-ssh-remote") || String(id).includes("pi-ssh-remote-inherit")) continue; // required pair, reported above
    const v = verdictFor(id);
    if (!v)
      warn(`unreviewed package: ${id} — review its tools before trusting the lockdown; add a verdict to ${KNOWN_PACKAGES} if safe`);
    else if (v.startsWith("safe")) ok(`${id}: ${v.replace(/^safe( \(class\))?: ?/i, "")}`);
    else if (v.startsWith("warn")) warn(`${id}: ${v.replace(/^warn( \(if installed\))?: ?/i, "")}`);
    else problem(`${id}: ${v.replace(/^problem( \(if installed\))?: ?/i, "")}`, `adjust or remove the package (verdict lives in ${KNOWN_PACKAGES})`);
  }

  const defaultTools = settings?.defaultTools;
  if (Array.isArray(defaultTools) && defaultTools.some((t) => String(t) === "powershell"))
    problem("defaultTools includes 'powershell' — it is never routed to the remote: local shell in SSH sessions",
      `remove it from defaultTools in ${AGENT_SETTINGS}`);
  else ok(`defaultTools: ${JSON.stringify(defaultTools ?? "(unset — read/bash/edit/write)")}`);

  const mcpFiles = [join(AGENT_DIR, "mcp.json")];
  let trustProjects = [];
  try { trustProjects = Object.keys(JSON.parse(readFileSync(TRUST, "utf8"))); } catch { /* no trust file */ }
  for (const proj of trustProjects)
    mcpFiles.push(join(proj, ".pi", "mcp.json"));
  const live = mcpFiles.filter(existsSync);
  if (live.length)
    problem(`MCP server config present: ${live.join(", ")} → MCP tools are local processes, never SSH-routed`,
      "remove the mcp.json file(s) or accept local-process tools");
  else ok("no mcp.json (no MCP servers)");

  const localSkills = trustProjects
    .map((p) => join(p, ".pi", "skills"))
    .filter(existsSync);
  if (localSkills.length)
    note(`project-local skills (trusted-user territory, not flagged): ${localSkills.join(", ")}`);
}

// ------------------------------------------- tool shadowing (drift check)
console.log("Tool shadowing (drift check):");
{
  // The SDK registry gives session custom tools (pi-web's) top precedence over
  // extension-registered tools over built-ins. ssh-remote makes the built-in
  // file/shell tools remote by registering remote COPIES of them. So any local
  // tool registered under a built-in name (pi-web wrapper OR other package)
  // would silently shadow the remote version. This section re-derives the
  // collision set from the code installed RIGHT NOW, on every run.
  const nvmRoot = dirname(dirname(process.execPath));
  const sdkToolsDir = join(nvmRoot, "lib", "node_modules", "@earendil-works/pi-coding-agent", "dist", "core", "tools");
  let builtinNames = [];
  try { builtinNames = readdirSync(sdkToolsDir).filter((f) => /^[a-z-]+\.js$/.test(f)).map((f) => f.replace(".js", "")); } catch {}
  if (!builtinNames.length)
    warn("could not enumerate the SDK's built-in tools - shadowing drift check degraded");
  const builtin = new Set(builtinNames);
  const factoryFor = (n) => `create${n[0].toUpperCase()}${n.slice(1)}ToolDefinition`;

  // 1) does the installed pi-web wrap any built-in locally? (calls to the SDK's
  //    built-in factories anywhere in pi-web's dist)
  const pwDist = join(nvmRoot, "lib", "node_modules", "@jmfederico/pi-web", "dist");
  let wrapped = new Set();
  if (existsSync(pwDist)) {
    const files = readdirSync(pwDist, { recursive: true }).filter((f) => String(f).endsWith(".js"));
    for (const f of files) {
      const src = readFileSync(join(pwDist, f), "utf8");
      for (const n of builtinNames) if (src.includes(factoryFor(n) + "(")) wrapped.add(n);
    }
  } else warn("pi-web dist not found for this node - cannot check pi-web tool wrapping");

  // 2) the guard's protected set (single source of truth: the guard file)
  const guardSrc = existsSync(GUARD) ? readFileSync(GUARD, "utf8") : "";
  const m = guardSrc.match(/\[([^\]]+)\]\.includes\(t\.name\)/);
  const protectedSet = new Set(m ? (m[1].match(/"[a-z_]+"/g) ?? []).map((x) => x.slice(1, -1)) : []);
  if (!m)
    problem("could not parse the guard's protected-tool list from " + GUARD,
      "the guard must keep its [\"name\", ...].includes(t.name) filter literal");
  else {
    for (const n of [...wrapped].sort())
      protectedSet.has(n)
        ? ok(`pi-web wraps '${n}' locally; guard filter covers it`)
        : problem(`pi-web now wraps built-in '${n}' locally but the guard's filter does NOT cover it - a local '${n}' would shadow the remote '${n}' in SSH sessions`,
          `add \"${n}\" to the filter list in ${GUARD}`);
    if (!wrapped.size) note("no built-in wrapping detected in pi-web (only edit is known today)");
  }

  // 2b) the deployed facade patch must implement the guard's FULL list. A stale
  //     patch (an older, narrower filter) only self-heals when pi-web replaces
  //     the facade, so flag it explicitly.
  const facadeNow = FACADE_CANDIDATES.find(existsSync);
  if (facadeNow && m) {
    const facSrc = readFileSync(facadeNow, "utf8");
    const fm = facSrc.match(/\[([^\]]+)\]\.includes\(t\.name\)/);
    if (fm) {
      const facadeSet = new Set((fm[1].match(/"[a-z_]+"/g) ?? []).map((x) => x.slice(1, -1)));
      const missing = [...protectedSet].filter((x) => !facadeSet.has(x));
      missing.length
        ? problem(`facade patch is STALE: it covers ${[...facadeSet].join(", ")} but the guard's list is ${[...protectedSet].join(", ")} - a ${missing.join("/")} wrapper would get through`,
          `cp ${BAK} ${facadeNow} and restart pi-web-sessiond so the guard re-patches`)
        : ok(`facade patch matches the guard's filter (${[...facadeSet].join(", ")})`);
    }
  }

  // 3) other installed packages registering built-in tool names (best effort:
  //    literal name:"..." registrations only; minified/dynamic names are missed)
  const { value: settings } = readJson(AGENT_SETTINGS);
  for (const id of settings?.packages ?? []) {
    const x = String(id);
    if (x.includes("pi-ssh-remote")) continue; // required pair: ssh-remote's own registrations are the authorized remote ones
    const dir = pkgDir(id);
    if (!existsSync(dir)) continue;
    const found = new Set();
    try {
      for (const f of readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".js"))) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const mm of src.matchAll(/registerTool\(\{\s*name:\s*"([a-z_]+)"/g)) if (builtin.has(mm[1])) found.add(mm[1]);
      }
    } catch {}
    if (found.size)
      problem(`package ${id} registers built-in tool name(s) ${[...found].join(", ")} (LOCAL) - in SSH sessions these shadow the remote versions`,
        `remove the tool registration or the package (verdict belongs in ${KNOWN_PACKAGES})`);
  }
  note("shadowing scan is best-effort static analysis: tools registered with dynamic/minified names are not detected");
}

// ------------------------------------------------------------------- optional
console.log("Defense-in-depth (optional, not required for the lockdown):");
{
  const { value: sandbox } = readJson(SANDBOX);
  sandbox?.enabled
    ? note("sandbox: enabled (local-zone processes are contained by its ACLs)")
    : note("sandbox: disabled — local-zone processes have unrestricted fs/network (the local zone is a trusted-model zone by design)");
}

// --------------------------------------------------------------------- verdict
console.log("Accepted by design (not fixable via settings):");
note("local sessions keep local file tools — remote tools share names with local tools, so settings cannot disable local without killing remote; a 'seal' extension (code) is the only fix if that zone ever matters");
note("skill-directory reads resolve locally even in SSH sessions (ssh-remote design; bounded read of package sources only)");

console.log(`\nVerdict: ${problems.length} problem(s), ${warnings.length} warning(s)`);
if (problems.length) {
  console.log("Problems to rectify:");
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p.split("\n")[0]}`));
  process.exit(1);
}
process.exit(warnings.length ? 2 : 0);
