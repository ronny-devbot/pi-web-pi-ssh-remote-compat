/**
 * pi-ssh-remote-inherit
 *
 * Bridges pi-ssh-remote's per-session state into pi-web's inheritable
 * session state (custom entries of type "pi-web.session-state" with
 * `inherit: true`).
 *
 * Parent side: whenever pi-ssh-remote changes the environment (connect,
 * cd, exit) or the session starts/resumes, the latest `pi-ssh-remote-state`
 * or `pi-ssh-local-state` entry is mirrored into a `pi-web.session-state`
 * entry under the namespace "ssh-remote". pi-web >= 1.202611.3 copies
 * `inherit: true` entries into sessions spawned from this one.
 *
 * Child side: at session_start, if the session file was seeded with a
 * "ssh-remote" session-state entry, it is re-appended as a regular
 * pi-ssh-remote-state / pi-ssh-local-state entry so pi-ssh-remote's own
 * session_start handler restores it.
 *
 * Ordering requirement: this package must load BEFORE pi-ssh-remote. Load
 * order is the project .pi/settings.json packages (array order) followed by
 * the user ~/.pi/agent/settings.json packages (array order). The extension
 * verifies this at session_start and warns when it is violated.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const SESSION_STATE_TYPE = "pi-web.session-state";
const SSH_REMOTE_STATE_TYPE = "pi-ssh-remote-state";
const SSH_LOCAL_STATE_TYPE = "pi-ssh-local-state";
const NAMESPACE = "ssh-remote";
const ENV_EVENT = "ssh-remote:environment";
const MAX_STATE_BYTES = 64 * 1024; // pi-web session-state limit

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Last entry in branch (append) order whose customType is one of `types`. */
export function latestCustom(
  entries: unknown[],
  types: string[],
): { customType: string; data: unknown } | undefined {
  let found: { customType: string; data: unknown } | undefined;
  for (const entry of entries) {
    if (!isObj(entry) || entry["type"] !== "custom") continue;
    if (typeof entry["customType"] === "string" && types.includes(entry["customType"])) {
      found = { customType: entry["customType"], data: entry["data"] };
    }
  }
  return found;
}

/** Latest valid pi-web.session-state entry with our namespace, if any. */
export function latestSessionState(
  entries: unknown[],
): { value: unknown } | undefined {
  for (const entry of entries) {
    if (!isObj(entry) || entry["type"] !== "custom") continue;
    if (entry["customType"] !== SESSION_STATE_TYPE) continue;
    const data = entry["data"];
    if (
      !isObj(data)
      || data["version"] !== 1
      || data["namespace"] !== NAMESPACE
      || typeof data["inherit"] !== "boolean"
    ) {
      continue;
    }
    return { value: data["value"] };
  }
  return undefined;
}

function isRemoteState(value: unknown): boolean {
  return isObj(value)
    && typeof value["target"] === "string"
    && value["target"].length > 0;
}

/**
 * Parent side: the pi-web.session-state data to mirror for the current
 * branch, or undefined when the session has no ssh state yet (keep
 * non-ssh sessions clean).
 */
export function computeMirror(
  branch: unknown[],
): { version: 1; namespace: string; value: unknown; inherit: true } | undefined {
  const marker = latestCustom(branch, [SSH_REMOTE_STATE_TYPE, SSH_LOCAL_STATE_TYPE]);
  if (!marker || !isObj(marker.data)) return undefined;
  if (new TextEncoder().encode(JSON.stringify(marker.data)).length > MAX_STATE_BYTES) {
    return undefined;
  }
  return { version: 1, namespace: NAMESPACE, value: marker.data, inherit: true };
}

/**
 * Child side: the single entry to append so pi-ssh-remote can restore the
 * seeded state. Empty when nothing is seeded, or when the branch already
 * carries an ssh marker of its own (equal or different).
 */
export function computeAdoption(
  branch: unknown[],
): Array<{ customType: string; data: unknown }> {
  const seeded = latestSessionState(branch);
  if (!seeded) return [];
  const remote = isRemoteState(seeded.value);
  const customType = remote ? SSH_REMOTE_STATE_TYPE : SSH_LOCAL_STATE_TYPE;
  const data = remote ? seeded.value : isObj(seeded.value) ? seeded.value : { version: 1 };
  // Adopt only when the session has no ssh marker of its own. If one exists
  // (equal: already adopted on a previous start; different: the session
  // moved on since spawn), leave it untouched.
  if (latestCustom(branch, [SSH_REMOTE_STATE_TYPE, SSH_LOCAL_STATE_TYPE])) return [];
  return [{ customType, data }];
}

/**
 * Verify this package loads before pi-ssh-remote. Load order is project
 * packages (array order) followed by user packages (array order). Returns a
 * warning message when the order is wrong, undefined when OK or when either
 * package's install source is not recognizable.
 */
export function checkPackageOrder(cwd: string, homeDir: string = homedir()): string | undefined {
  const readPackages = (file: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return isObj(parsed)
        && Array.isArray(parsed["packages"])
        ? (parsed["packages"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
    } catch {
      return [];
    }
  };
  const projectFile = join(cwd, ".pi", "settings.json");
  const userFile = join(homeDir, ".pi", "agent", "settings.json");
  const ordered: Array<{ file: string; source: string }> = [
    ...readPackages(projectFile).map((source) => ({ file: projectFile, source })),
    ...readPackages(userFile).map((source) => ({ file: userFile, source })),
  ];
  const isMine = (s: string): boolean => s.includes("pi-ssh-remote-inherit");
  // Matches the npm package and the known git fork of it.
  const isTheirs = (s: string): boolean =>
    (s.includes("pi-ssh-remote") && !s.includes("pi-ssh-remote-inherit"))
    || s.includes("pi-extensions@custom/main");
  const mine = ordered.findIndex((e) => isMine(e.source));
  const theirs = ordered.findIndex((e) => isTheirs(e.source));
  if (mine === -1 || theirs === -1) return undefined;
  if (mine < theirs) return undefined;
  return (
    `loaded after pi-ssh-remote ("${ordered[theirs].source}"), so child-session adoption is inactive. `
    + `List "git:github.com/ronny-devbot/pi-ssh-remote-inherit" before that entry in ${ordered[theirs].file}`
  );
}

export default function sshRemoteInheritExtension(pi: ExtensionAPI): void {
  let manager: SessionManager | undefined;
  let lastMirrorJson = "";

  const mirror = (branch: unknown[]): void => {
    const data = computeMirror(branch);
    if (!data) return;
    const json = JSON.stringify(data);
    if (json === lastMirrorJson) return;
    lastMirrorJson = json;
    pi.appendEntry(SESSION_STATE_TYPE, data);
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    manager = ctx.sessionManager;
    const orderProblem = checkPackageOrder(ctx.cwd);
    if (orderProblem) {
      ctx.ui.notify(`[pi-ssh-remote-inherit] ${orderProblem}`, "warning");
    }
    for (const entry of computeAdoption(ctx.sessionManager.getBranch())) {
      pi.appendEntry(entry.customType, entry.data);
    }
    mirror(ctx.sessionManager.getBranch());
  });

  // The event payload alone is incomplete (no port/home/shell), so the
  // handler only triggers a re-read of the branch, which pi-ssh-remote has
  // already updated by the time a "succeeded" event is emitted.
  pi.events.on(ENV_EVENT, (data: unknown) => {
    if (!manager) return;
    if (isObj(data) && data["status"] === "succeeded") mirror(manager.getBranch());
  });

  pi.on("message_end", () => {
    if (manager) mirror(manager.getBranch());
  });
}
