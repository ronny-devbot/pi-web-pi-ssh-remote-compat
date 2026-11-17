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
 * verifies this at session_start and reports violations.
 *
 * Fail closed: a session seeded with a remote state must never run silently
 * on local files. Every path where the remote cannot be active (package
 * order wrong, session marked local, malformed state) produces a loud error
 * notification naming the cause. When adoption succeeds, pi-ssh-remote
 * itself fails closed (its tools throw) if the connection cannot be made.
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

export function isRemoteState(value: unknown): boolean {
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
  // Round-trip through JSON: pi-web's live-session spawn path clones the
  // in-memory value, where e.g. `port: undefined` (dropped from the on-disk
  // copy) would trip its "only JSON values" check.
  const value: unknown = JSON.parse(JSON.stringify(marker.data));
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_STATE_BYTES) {
    return undefined;
  }
  return { version: 1, namespace: NAMESPACE, value, inherit: true };
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

/**
 * Count malformed pi-web.session-state entries in our namespace (present but
 * failing the version/inherit validation). These are skipped by
 * latestSessionState; if they are the only state present, inheritance would
 * silently not happen — report it instead.
 */
export function countMalformedSessionStates(entries: unknown[]): number {
  let count = 0;
  for (const entry of entries) {
    if (!isObj(entry) || entry["type"] !== "custom") continue;
    if (entry["customType"] !== SESSION_STATE_TYPE) continue;
    const data = entry["data"];
    if (!isObj(data) || data["namespace"] !== NAMESPACE) continue;
    if (data["version"] !== 1 || typeof data["inherit"] !== "boolean") count++;
  }
  return count;
}

/**
 * Fail-closed reporting for session_start. Returns the notifications the
 * session must surface: a seeded remote state that ends up local is never
 * silent. Empty when the session is legitimately local (local or no seeded
 * state) or correctly remote (adoption happened; pi-ssh-remote fails closed
 * itself if the connection then fails).
 */
export function adoptionReport(
  branch: unknown[],
  orderProblem: string | undefined,
): Array<{ level: "error" | "warning"; message: string }> {
  const out: Array<{ level: "error" | "warning"; message: string }> = [];
  const seeded = latestSessionState(branch);
  const remote = isRemoteState(seeded ? seeded.value : undefined);
  if (remote && seeded) {
    const target = (seeded.value as Record<string, unknown>)["target"] as string;
    if (orderProblem) {
      // The state entry is appended after pi-ssh-remote resolved this start,
      // so this run stays local. A later resume of the same session adopts
      // correctly (the entry is then already in the file); only the first
      // start of a freshly spawned session loses the race.
      out.push({
        level: "error",
        message:
          `inherited SSH workspace "${target}" was NOT applied: this package ${orderProblem}. ` +
          `This session is running on LOCAL files. Fix the package order and restart the session, ` +
          `or connect explicitly with /ssh-connect (and /ssh-exit to go back).`,
      });
    } else if (computeAdoption(branch).length === 0) {
      // Skipped because the session already carries its own marker. If that
      // marker is "local" while the last inherited state was remote, surface it.
      const latest = latestCustom(branch, [SSH_REMOTE_STATE_TYPE, SSH_LOCAL_STATE_TYPE]);
      if (latest && latest.customType === SSH_LOCAL_STATE_TYPE) {
        out.push({
          level: "error",
          message:
            `session is marked local, but the last inherited SSH state was remote ("${target}"). ` +
            `It is running on LOCAL files — use /ssh-connect if that is not intended.`,
        });
      }
    }
  }
  const malformed = countMalformedSessionStates(branch);
  if (malformed > 0 && !seeded) {
    out.push({
      level: "error",
      message:
        `${malformed} malformed "ssh-remote" session-state entr${malformed === 1 ? "y" : "ies"} ` +
        `found; inheritance was skipped and this session is local. Update pi-ssh-remote-inherit.`,
    });
  }
  return out;
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
    const branch = ctx.sessionManager.getBranch();
    const orderProblem = checkPackageOrder(ctx.cwd);
    for (const entry of computeAdoption(branch)) {
      pi.appendEntry(entry.customType, entry.data);
    }
    const reports = adoptionReport(branch, orderProblem);
    if (reports.length === 0 && orderProblem) {
      reports.push({ level: "warning", message: orderProblem });
    }
    for (const report of reports) {
      ctx.ui.notify(`[pi-ssh-remote-inherit] ${report.message}`, report.level);
    }
    mirror(branch);
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
