import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionsStore, demoOverride, describeSelf, readPackage } from "../server/release-notes";
import { LEGACY_BASELINE, RECENT_UPDATE_MS, recentNotes, recentUpdate, releaseNotesViewSchema, whatsNew, type ReleaseNote } from "../shared/changelog";

const dir = () => mkdtemp(join(tmpdir(), "follow-up-versions-"));

test("versions: a fresh install has no previous version, so What's new stays quiet and setup speaks", async () => {
  const store = new VersionsStore(await dir(), () => 1000);
  const file = await store.started("1.4.0-beta.21", false);
  assert.deepEqual(file, { running: "1.4.0-beta.21", previous: null, startedAt: null });
  assert.deepEqual(whatsNew({ installed: "1.4.0-beta.21", deviceSeen: null, previous: file.previous ?? null, onboarding: false, notes: [] }), { show: false, reason: "first-run", record: "1.4.0-beta.21" });
});

test("versions: an existing install's first version with notes starts from the legacy baseline", async () => {
  const store = new VersionsStore(await dir(), () => 5000);
  const file = await store.started("1.4.0-beta.23", true);
  assert.equal(file.previous, LEGACY_BASELINE);
  assert.equal(file.startedAt, 5000, "counts as an update, so Home says Updated to");
  // The baseline itself (or older) is not an update.
  assert.equal((await new VersionsStore(await dir()).started(LEGACY_BASELINE, true)).previous, null);
});

test("versions: a version change moves the old one to previous and stamps the time; a restart changes nothing", async () => {
  const d = await dir(); let now = 1;
  const store = new VersionsStore(d, () => now);
  await store.started("1.4.0-beta.21", false);
  now = 2; const updated = await store.started("1.4.0-beta.22", false);
  assert.deepEqual(updated, { running: "1.4.0-beta.22", previous: "1.4.0-beta.21", startedAt: 2 });
  now = 3; assert.deepEqual(await new VersionsStore(d, () => now).started("1.4.0-beta.22", true), updated, "a worker restart on the same version keeps the record");
  assert.deepEqual(JSON.parse(await readFile(join(d, "versions.json"), "utf8")), updated);
});

test("versions: the host-wide seen record only moves forward", async () => {
  const store = new VersionsStore(await dir());
  assert.equal((await store.seen("1.4.0-beta.22")).hostSeen, "1.4.0-beta.22");
  assert.equal((await store.seen("1.4.0-beta.21")).hostSeen, "1.4.0-beta.22");
  assert.equal((await store.seen("1.4.0")).hostSeen, "1.4.0");
});

test("versions: concurrent writes are serialised, none lost", async () => {
  const store = new VersionsStore(await dir());
  await Promise.all([store.started("1.4.0-beta.21", false), store.seen("1.4.0-beta.21")]);
  const file = await store.read();
  assert.equal(file.running, "1.4.0-beta.21"); assert.equal(file.hostSeen, "1.4.0-beta.21");
});

test("self: install kind and path come from Paseo's plugin list", () => {
  const rows = [{ id: "other", path: "/x" }, { id: "follow-up", path: "/p", status: "running", installation: { identity: { kind: "npm" }, currentRevision: "1.4.0-beta.21" } }];
  assert.deepEqual(describeSelf(rows), { id: "follow-up", path: "/p", version: "1.4.0-beta.21", installKind: "npm", status: "running", error: null, registry: null });
  assert.equal(describeSelf([{ id: "follow-up", path: "/p", source: "directory" }]).installKind, "directory");
  assert.equal(describeSelf([{ id: "follow-up", path: "/p", installation: { identity: { kind: "npm", registry: {} } } }]).installKind, "registry");
  // A registry install carries where it came from: 2.0's move reinstalls from that registry (server/plugin-move.ts).
  assert.deepEqual(describeSelf([{ id: "follow-up", path: "/p", installation: { identity: { kind: "npm", registry: { url: "https://plugins.paseo.sh", id: "tomgrin10/follow-up" } }, currentRevision: "1.0.1" } }]).registry, { url: "https://plugins.paseo.sh", id: "tomgrin10/follow-up" });
  assert.equal(describeSelf([]).installKind, "unknown");
});

test("self: the package's version and notes are read from its own folder", async () => {
  const d = await dir();
  await writeFile(join(d, "package.json"), JSON.stringify({ version: "1.4.0-beta.21" }));
  await writeFile(join(d, "CHANGELOG.md"), "# Release notes\n\n## 1.4.0-beta.21 (2026-11-10)\n\n- One.\n");
  assert.deepEqual(await readPackage(d), { version: "1.4.0-beta.21", name: null, notes: [{ version: "1.4.0-beta.21", date: "2026-11-10", items: ["One."] }] });
  // The display name comes from the manifest, as the notes' titles use it.
  await writeFile(join(d, "paseo-plugin.json"), JSON.stringify({ id: "follow-up", name: "Follow-up" }));
  assert.equal((await readPackage(d)).name, "Follow-up");
  assert.deepEqual(await readPackage(join(d, "missing")), { version: null, name: null, notes: [] });
});

const notes: ReleaseNote[] = [22, 21, 20].map(n => ({ version: `1.4.0-beta.${n}`, date: null, items: [`Note ${n}.`] }));
test("recent: Home's Updated line lasts three days after a real update", () => {
  assert.equal(recentUpdate({ version: "1.4.0-beta.22", notes, previous: "1.4.0-beta.21", updatedAt: 0 }, RECENT_UPDATE_MS - 1), true);
  assert.equal(recentUpdate({ version: "1.4.0-beta.22", notes, previous: "1.4.0-beta.21", updatedAt: 0 }, RECENT_UPDATE_MS), false);
  assert.equal(recentUpdate({ version: "1.4.0-beta.22", notes, previous: null, updatedAt: 0 }, 1), false, "fresh install");
  assert.equal(recentUpdate({ version: "1.4.0-beta.22", notes, previous: "1.4.0-beta.21", updatedAt: null }, 1), false);
  assert.deepEqual(recentNotes({ version: "1.4.0-beta.22", previous: "1.4.0-beta.20", notes }).map(n => n.version), ["1.4.0-beta.22", "1.4.0-beta.21"]);
  assert.deepEqual(recentNotes({ version: "1.4.0-beta.22", previous: null, notes }).map(n => n.version), ["1.4.0-beta.22"], "no baseline: this version's own notes");
});

test("demo override: only with FOLLOW_UP_UPDATES_DEMO=1, relative times become absolute", async () => {
  const d = await dir(); await mkdir(d, { recursive: true });
  const view = { version: "1.4.0-beta.21", name: "Follow-up", installKind: "npm" as const, previous: null, updatedAt: null, hostSeen: null, notes: [] };
  await writeFile(join(d, "release-notes-demo.json"), JSON.stringify({ previous: "1.4.0-beta.20", updatedAt: "-60000" }));
  assert.deepEqual(await demoOverride(d, "release-notes", releaseNotesViewSchema, view, {}), view);
  const out = await demoOverride(d, "release-notes", releaseNotesViewSchema, view, { FOLLOW_UP_UPDATES_DEMO: "1" });
  assert.equal(out.previous, "1.4.0-beta.20"); assert.ok(Math.abs(Date.now() - 60000 - out.updatedAt!) < 5000);
});

test("release_notes is a read-only agent tool for follow.release-notes; closing What's new is exempt", async () => {
  const { READ_ONLY_TOOLS } = await import("../server/agent-actions");
  const { PARITY, RPC_TOOLS } = await import("../server/agent-parity");
  assert.ok((READ_ONLY_TOOLS as readonly string[]).includes("release_notes"));
  assert.equal(RPC_TOOLS.find(t => t.name === "release_notes")?.rpc, "follow.release-notes");
  assert.deepEqual(PARITY["follow.release-notes"], { tools: ["release_notes"] });
  assert.ok("exempt" in PARITY["follow.whats-new-seen"]!);
});

test("ago: minutes under an hour, hours under two days, then days", async () => {
  const { agoText } = await import("../shared/changelog");
  assert.equal(agoText(20_000), "just now");
  assert.equal(agoText(29 * 60_000), "29m ago");
  assert.equal(agoText(2 * 3_600_000 + 59 * 60_000), "2h ago");
  assert.equal(agoText(3 * 86_400_000), "3 days ago");
});

test("versions: going back to an older version (a rollback) isn't an update", async () => {
  const { mkdtemp } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { VersionsStore: Store } = await import("../server/release-notes");
  const store = new Store(await mkdtemp(join(tmpdir(), "versions-")), () => 1_000);
  await store.started("1.4.0-beta.24", true);
  await store.started("1.4.0-beta.25", true);
  assert.equal((await store.read()).previous, "1.4.0-beta.24");
  const back = await store.started("1.4.0-beta.24", true);
  assert.equal(back.running, "1.4.0-beta.24"); assert.equal(back.previous, null); assert.equal(back.startedAt, null);
});
