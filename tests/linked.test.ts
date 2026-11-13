import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIMITS, applyCheck, classifyLink, dueChecks, emptyLinkedFile, emptyWorkspaceLinks, excludeItem, linkedCounts, migrateAboutLinks, noteCandidate, setTeams, toneOf, unexcludeItem, upsertItem,
  type LinkedFile,
} from "../shared/linked";
import { LinkedService, LinkedStore, parseLinearTeams } from "../server/linked";

const clock = Date.parse("2026-11-10T10:00:00Z");
const withTeams = (keys = ["HER"]) => { const f = emptyLinkedFile(); setTeams(f, keys, clock); return f; };
const items = (f: LinkedFile, w = "w1") => f.workspaces[w]?.items.map(i => i.key) ?? [];

test("identity: a Linear URL and its bare key are one item; Slack replies collapse to the thread; PRs are refused", () => {
  assert.equal(classifyLink("https://linear.app/acme/issue/HER-1312/vendor-sync")?.key, "HER-1312");
  assert.equal(classifyLink("her-1312")?.key, "HER-1312");
  assert.equal(classifyLink("https://acme.slack.com/archives/C01/p1700000000000100?thread_ts=1699999999.000200")?.key, "slack:C01/1699999999.000200");
  assert.equal(classifyLink("https://github.com/acme/app/pull/12")?.kind, "pr");
  assert.deepEqual(classifyLink("https://github.com/acme/app/issues/882#issuecomment-1"), { kind: "issue", key: "acme/app#882", url: "https://github.com/acme/app/issues/882" });
  assert.equal(classifyLink("https://www.rfc-editor.org/rfc/rfc4180"), null, "a generic URL only when linked on purpose");
  assert.equal(classifyLink("https://www.rfc-editor.org/rfc/rfc4180#section-2", true)?.key, "https://www.rfc-editor.org/rfc/rfc4180");
  const ws = emptyWorkspaceLinks();
  upsertItem(ws, { key: "HER-1312", kind: "linear", url: null, origin: "extracted" }, clock);
  upsertItem(ws, { key: "HER-1312", kind: "linear", url: "https://linear.app/acme/issue/HER-1312", title: "Vendor sync drops SCIM groups", origin: "registered", by: "main", why: "started from this" }, clock + 1);
  assert.equal(ws.items.length, 1);
  assert.deepEqual([ws.items[0].origin, ws.items[0].why, ws.items[0].url], ["registered", "started from this", "https://linear.app/acme/issue/HER-1312"]);
  upsertItem(ws, { key: "HER-1312", kind: "linear", url: null, origin: "extracted", why: "noise" }, clock + 2);
  assert.equal(ws.items[0].origin, "registered", "a less trusted origin never downgrades");
});

test("validation: non-issues never become items; Linear decides; not-found is remembered; failures back off and never render", () => {
  const f = withTeams();
  assert.equal(noteCandidate(f, "w1", "STATUS-1025", clock), false, "STATUS isn't a Linear team");
  assert.equal(noteCandidate(f, "w1", "REVISION-2026", clock), false);
  assert.equal(noteCandidate(f, "w1", "HER-1312", clock), true);
  assert.equal(noteCandidate(f, "w1", "HER-99999", clock), true);
  assert.equal(noteCandidate(f, "w1", "HER-1390", clock), true);
  assert.deepEqual(items(f), [], "candidates never render");
  assert.deepEqual(linkedCounts(f.workspaces.w1), {});
  applyCheck(f, "HER-1312", { found: { title: "Vendor sync drops SCIM groups", state: "In Progress", url: "https://linear.app/acme/issue/HER-1312" } }, clock);
  applyCheck(f, "HER-99999", { found: null }, clock);
  applyCheck(f, "HER-1390", { error: "Linear unreachable" }, clock);
  assert.deepEqual(items(f), ["HER-1312"]); assert.equal(f.workspaces.w1.items[0].statusTone, "active");
  assert.ok(f.rejected["HER-99999"]);
  assert.equal(noteCandidate(f, "w2", "HER-99999", clock), false, "a rejected key is never checked again, in any workspace");
  assert.deepEqual(dueChecks(f, clock), [], "the failed one waits an hour");
  assert.deepEqual(dueChecks(f, clock + 3_600_001), [{ workspaceId: "w1", key: "HER-1390" }]);
  for (let i = 0; i < 3; i++) applyCheck(f, "HER-1390", { error: "Linear unreachable" }, clock);
  assert.deepEqual(f.workspaces.w1.candidates, [], "dropped after its retries, still never an item");
  assert.deepEqual(items(f), ["HER-1312"]);
});

test("unknown teams: candidates wait; when the list arrives, the ones that aren't teams go", () => {
  const f = emptyLinkedFile();
  noteCandidate(f, "w1", "STATUS-1025", clock); noteCandidate(f, "w1", "HER-1312", clock);
  assert.deepEqual(dueChecks(f, clock), [], "no checks until the team list is known");
  setTeams(f, parseLinearTeams(JSON.stringify({ teams: [{ id: "t1", key: "HER", name: "Acme" }, { id: "t2", key: "OPS" }] })), clock);
  assert.deepEqual(f.workspaces.w1.candidates.map(c => c.key), ["HER-1312"]);
  assert.deepEqual(parseLinearTeams('noise {"key": "HER"} {"key":"lower"}'), ["HER"]);
});

test("exclusion sticks across every origin; the developer adding it back clears it; undo restores", () => {
  const f = withTeams(); const ws = f.workspaces.w1 = emptyWorkspaceLinks();
  upsertItem(ws, { key: "HER-1290", kind: "linear", url: null, title: "Retry budget", origin: "registered" }, clock);
  const removed = excludeItem(ws, "HER-1290", "developer", null, clock);
  assert.equal(removed?.title, "Retry budget");
  assert.deepEqual(upsertItem(ws, { key: "HER-1290", kind: "linear", url: null, origin: "registered" }, clock), { ok: false, reason: "excluded" });
  assert.equal(noteCandidate(f, "w1", "HER-1290", clock), false);
  unexcludeItem(ws, "HER-1290", removed);
  assert.deepEqual(ws.items.map(i => i.title), ["Retry budget"]);
  excludeItem(ws, "HER-1290", "developer", null, clock);
  assert.equal(upsertItem(ws, { key: "HER-1290", kind: "linear", url: null, origin: "manual" }, clock).ok, true, "added by hand: the exclusion goes");
  assert.deepEqual(ws.excluded, []);
});

test("cap: the oldest extracted item makes room; registered and manual ones are never evicted silently", () => {
  const ws = emptyWorkspaceLinks();
  for (let i = 0; i < LIMITS.items; i++) upsertItem(ws, { key: `HER-${i + 1}`, kind: "linear", url: null, origin: i < 2 ? "extracted" : "registered" }, clock + i);
  assert.equal(upsertItem(ws, { key: "HER-900", kind: "linear", url: null, origin: "manual" }, clock + 100).ok, true);
  assert.ok(!ws.items.some(i => i.key === "HER-1"), "the oldest extracted one went");
  upsertItem(ws, { key: "HER-901", kind: "linear", url: null, origin: "registered" }, clock + 101);
  assert.deepEqual(upsertItem(ws, { key: "HER-902", kind: "linear", url: null, origin: "registered" }, clock + 102), { ok: false, reason: "cap" });
  assert.equal(ws.items.length, LIMITS.items);
});

test("counts leave out the spec; tones read Linear's states", () => {
  const ws = emptyWorkspaceLinks();
  upsertItem(ws, { key: "HER-1", kind: "linear", url: null, origin: "registered" }, clock);
  upsertItem(ws, { key: "https://claude.ai/artifact/spec", kind: "artifact", url: "https://claude.ai/artifact/spec", origin: "spec" }, clock);
  upsertItem(ws, { key: "https://claude.ai/artifact/report", kind: "artifact", url: "https://claude.ai/artifact/report", origin: "published" }, clock);
  assert.deepEqual(linkedCounts(ws), { linear: 1, artifact: 1 });
  assert.deepEqual(["Todo", "In Progress", "In Review", "Done", "Canceled", "Duplicate", null].map(toneOf), ["todo", "active", "active", "done", "cancelled", "cancelled", null]);
});

test("migration: only verified About links carry over; junk rows become candidates or go; it runs once", () => {
  const f = emptyLinkedFile();
  const about = { w1: { links: [
    { kind: "linear", key: "HER-1312", url: "https://linear.app/acme/issue/HER-1312", title: "Vendor sync drops SCIM groups", state: "In Progress" },
    { kind: "linear", key: "STATUS-1025", url: null, title: null },
    { kind: "linear", key: "HER-1340", url: null, title: null },
    { kind: "pr", key: "acme/app#12", url: "https://github.com/acme/app/pull/12", title: "Fix" },
    { kind: "slack", key: "slack:C01/1.2", url: "https://acme.slack.com/archives/C01/p1", title: "#eng-identity" },
    { kind: "slack", key: "slack:C02/3.4", url: "https://acme.slack.com/archives/C02/p3", title: null },
    { kind: "artifact", key: "https://claude.ai/artifact/a", url: "https://claude.ai/artifact/a", title: null },
  ] } };
  assert.deepEqual(migrateAboutLinks(f, about, clock), { items: 3, candidates: 2 });
  assert.deepEqual(items(f), ["HER-1312", "slack:C01/1.2", "https://claude.ai/artifact/a"]);
  setTeams(f, ["HER"], clock);
  assert.deepEqual(f.workspaces.w1.candidates.map(c => c.key), ["HER-1340"], "STATUS-1025 goes once teams are known");
  assert.deepEqual(migrateAboutLinks(f, about, clock), { items: 0, candidates: 0 }, "once");
});

test("the service: an empty queue makes no call; the team list is read once; the daily budget holds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linked-"));
  const calls: string[] = [];
  let now = clock;
  const store = new LinkedStore(dir);
  const service = new LinkedService({ store, now: () => now, sources: {
    async teams() { calls.push("teams"); return ["HER"]; },
    async issue(key) { calls.push(key); return key === "HER-2" ? null : { title: `Issue ${key}`, state: "Todo", url: null }; },
  } });
  try {
    assert.deepEqual(await service.drain(), { checked: 0, skipped: null }); assert.deepEqual(calls, []);
    await store.mutate(f => { for (let i = 1; i <= 8; i++) noteCandidate(f, "w1", `HER-${i}`, clock + i); });
    assert.deepEqual(await service.drain(), { checked: 6, skipped: null });
    assert.deepEqual(calls, ["teams", "HER-1", "HER-2", "HER-3", "HER-4", "HER-5", "HER-6"]);
    const file = await store.read();
    assert.equal(file.workspaces.w1.items.length, 5); assert.ok(file.rejected["HER-2"]);
    await service.drain();
    assert.equal(calls.filter(c => c === "teams").length, 1, "the team list is cached for a day");
    await store.mutate(f => { f.daily = { date: new Date(now).toISOString().slice(0, 10), count: LIMITS.dailyChecks }; noteCandidate(f, "w1", "HER-50", now); });
    assert.deepEqual(await service.drain(), { checked: 0, skipped: "daily-cap" });
    await writeFile(join(dir, "linked.json"), "not json");
    assert.deepEqual((await store.read()).workspaces, {}, "a corrupt file reads as empty");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
