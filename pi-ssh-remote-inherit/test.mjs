// Runnable self-check: node test.mjs
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeMirror,
  computeAdoption,
  latestCustom,
  latestSessionState,
  checkPackageOrder,
  adoptionReport,
  countMalformedSessionStates,
} from "./index.ts";

const remoteState = {
  version: 2,
  target: "dev1",
  remotePlatform: "unix",
  remoteShell: "bash",
  remoteCwd: "/home/ronny",
  remoteHome: "/home/ronny",
};
const localState = { version: 1 };
const remoteEntry = { type: "custom", customType: "pi-ssh-remote-state", data: remoteState };
const localEntry = { type: "custom", customType: "pi-ssh-local-state", data: localState };
const seed = (value) => ({
  type: "custom",
  customType: "pi-web.session-state",
  data: { version: 1, namespace: "ssh-remote", value, inherit: true },
});

// -- computeMirror ---------------------------------------------------------
assert.equal(computeMirror([{ type: "message", message: {} }]), undefined, "no marker -> no mirror");
assert.deepEqual(
  computeMirror([remoteEntry]),
  { version: 1, namespace: "ssh-remote", value: remoteState, inherit: true },
  "remote marker -> inherit mirror",
);
assert.deepEqual(
  computeMirror([remoteEntry, localEntry]).value,
  localState,
  "latest marker wins (exit after connect)",
);
// pi-web's live spawn path clones the in-memory value: undefined properties
// (JSON.stringify drops them from the on-disk copy) must not survive the mirror.
const remoteWithUndefinedPort = { ...remoteState, port: undefined };
const m2 = computeMirror([{ type: "custom", customType: "pi-ssh-remote-state", data: remoteWithUndefinedPort }]);
assert.ok(m2 && !("port" in m2.value), "undefined port is stripped from the mirrored value");

// -- computeAdoption -------------------------------------------------------
assert.deepEqual(
  computeAdoption([seed(remoteState)]),
  [{ customType: "pi-ssh-remote-state", data: remoteState }],
  "seeded remote, no marker -> adopt remote",
);
assert.deepEqual(
  computeAdoption([seed(remoteState), remoteEntry]),
  [],
  "seeded remote, marker already equal -> dedup",
);
assert.deepEqual(
  computeAdoption([seed(remoteState), { ...remoteEntry, data: { ...remoteState, remoteCwd: "/tmp" } }]),
  [],
  "seeded remote, newer different marker -> do not overwrite",
);
assert.deepEqual(
  computeAdoption([seed(localState)]),
  [{ customType: "pi-ssh-local-state", data: localState }],
  "seeded local -> adopt local marker",
);
assert.deepEqual(
  computeAdoption([{ type: "custom", customType: "pi-web.session-state", data: { version: 1, namespace: "mcp", value: { x: 1 }, inherit: true } }]),
  [],
  "foreign namespace ignored",
);

// -- latestSessionState validation -----------------------------------------
assert.equal(latestSessionState([{ type: "custom", customType: "pi-web.session-state", data: { version: 2, namespace: "ssh-remote", value: {}, inherit: true } }]), undefined, "wrong version rejected");
assert.equal(latestSessionState([{ type: "custom", customType: "pi-web.session-state", data: { version: 1, namespace: "ssh-remote", value: {} } }]), undefined, "missing inherit rejected");

// -- latestCustom ------------------------------------------------------------
assert.deepEqual(
  latestCustom([localEntry, remoteEntry], ["pi-ssh-remote-state", "pi-ssh-local-state"]),
  { customType: "pi-ssh-remote-state", data: remoteState },
  "branch order (not id) decides the latest",
);

// -- adoptionReport (fail closed: seeded remote never ends up silently local) --
const ORDER = 'loaded after pi-ssh-remote ("npm:@99percentpeople/pi-ssh-remote")';
assert.deepEqual(adoptionReport([seed(remoteState)], undefined), [], "normal adoption -> no report (ssh-remote fails closed itself)");
assert.deepEqual(adoptionReport([seed(localState)], undefined), [], "seeded local -> legitimately local");
assert.deepEqual(adoptionReport([remoteEntry], undefined), [], "no seed -> local, no report");
let r = adoptionReport([seed(remoteState)], ORDER);
assert.equal(r.length, 1, "order problem + seeded remote -> one report");
assert.equal(r[0].level, "error");
assert.match(r[0].message, /LOCAL files/);
assert.match(r[0].message, /dev1/);
assert.deepEqual(adoptionReport([seed(localState)], ORDER), [], "order problem + seeded local -> no adoption report (handler adds generic warning)");
r = adoptionReport([seed(remoteState), localEntry], undefined);
assert.equal(r.length, 1, "seeded remote + local marker -> mismatch report");
assert.equal(r[0].level, "error");
assert.match(r[0].message, /marked local/);
r = adoptionReport([seed(remoteState), remoteEntry], undefined);
assert.deepEqual(r, [], "seeded remote + equal remote marker -> no report (already adopted)");
const malformed = { type: "custom", customType: "pi-web.session-state", data: { version: 9, namespace: "ssh-remote", value: remoteState, inherit: true } };
r = adoptionReport([malformed], undefined);
assert.equal(r.length, 1, "only malformed entries -> report");
assert.match(r[0].message, /malformed/);
assert.deepEqual(adoptionReport([malformed, seed(remoteState)], undefined), [], "malformed + valid -> valid wins, no report");
assert.equal(countMalformedSessionStates([{ type: "custom", customType: "pi-web.session-state", data: { version: 9, namespace: "mcp", value: {}, inherit: true } }]), 0, "foreign namespace not counted");

// -- checkPackageOrder -------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), "inherit-test-"));
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), "inherit-cwd-"));
const userSettings = join(home, ".pi", "agent", "settings.json");
const projectSettings = join(cwd, ".pi", "settings.json");

writeFileSync(userSettings, JSON.stringify({
  packages: ["npm:@99percentpeople/pi-ssh-remote", "git:github.com/ronny-devbot/pi-ssh-remote-inherit"],
}));
assert.ok(checkPackageOrder(cwd, home), "wrong order (glue after) -> warning");

writeFileSync(userSettings, JSON.stringify({
  packages: ["git:github.com/ronny-devbot/pi-ssh-remote-inherit", "npm:@99percentpeople/pi-ssh-remote"],
}));
assert.equal(checkPackageOrder(cwd, home), undefined, "correct order -> no warning");

mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(projectSettings, JSON.stringify({ packages: ["npm:@99percentpeople/pi-ssh-remote"] }));
assert.ok(checkPackageOrder(cwd, home), "project-scope ssh-remote always loads before user-scope glue -> warning");

writeFileSync(userSettings, JSON.stringify({ packages: ["npm:other-package"] }));
assert.equal(checkPackageOrder(cwd, home), undefined, "unrecognizable install source -> no (false) warning");

console.log("all glue tests passed");
