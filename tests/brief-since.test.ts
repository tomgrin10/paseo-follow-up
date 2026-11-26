// nobody-s-on-it-is-needs-you (AGENTS.md invariant 86): a raised issue with no workspace is a counted Needs-you row, with one set of actions on screen.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, testStore } from "./support/store-temp-dir";
import { LinearQueue, LinearQueueStore, type QueueReader } from "../server/linear-queue";
import { RPC_TOOLS } from "../server/agent-parity";
import { dismissRpc } from "../shared/contracts";
import { toLinearIssue, type LinearIssue } from "../shared/linear-issues";
import { defaultWorkdays, raisedNeeds, type Clock, type LogEntry } from "../shared/linear-queue";
import { changeChip, dueWords, openedAge, openedLine, queueRowMeta, raisedRow, sinceBlock, sinceWords, SINCE_LINES, type SinceChange } from "../shared/brief-since";

// The Morning brief's "Since" block, queue screen and decision Q8's raised issues (docs/morning-brief.md#in-the-brief).
// Fixtures are fictional (ACME-*, bob).

const TZ = "America/New_York";
const CLOCK: Clock = { timeZone: TZ, workdays: defaultWorkdays(TZ) };
// Monday 2026-11-23, 08:40 in New York.
const MON = Date.parse("2026-11-23T13:40:00.000Z");
const H = 3_600_000;

const change = (c: Partial<SinceChange> & { key: string; kinds: SinceChange["kinds"] }): SinceChange => ({
  title: `Issue ${c.key}`, url: null, priority: 4, priorityBefore: null, due: null, dueBefore: null, state: "Todo", stateBefore: null, left: null,
  at: "2026-11-21T12:00:00.000Z", line: "", workspace: null, ...c,
});

test("since words: today's time, yesterday, a weekday this week, else a date; due dates the same way", () => {
  assert.equal(sinceWords(null, MON, TZ), null);
  assert.equal(sinceWords("2026-11-23T12:12:00.000Z", MON, TZ), "Since 07:12");
  assert.equal(sinceWords("2026-11-22T20:00:00.000Z", MON, TZ), "Since yesterday");
  assert.equal(sinceWords("2026-11-20T22:00:00.000Z", MON, TZ), "Since Friday");
  assert.equal(sinceWords("2026-11-10T22:00:00.000Z", MON, TZ), "Since Nov 10");
  assert.equal(dueWords("2026-11-23", MON, TZ), "today");
  assert.equal(dueWords("2026-11-24", MON, TZ), "tomorrow");
  assert.equal(dueWords("2026-11-25", MON, TZ), "Wed");
  assert.equal(dueWords("2026-12-09", MON, TZ), "Dec 9");
});

test("the block: most urgent first, New's actions only on urgent or raised issues with no workspace, Low news folded, leavers on one line", () => {
  const view = {
    since: "2026-11-20T22:00:00.000Z", counts: { all: 47 },
    changes: [
      change({ key: "ACME-177", kinds: ["new"], priority: 1, due: "2026-11-25", title: "Webhook retries ignore the per-endpoint limit" }),
      change({ key: "ACME-142", kinds: ["raised"], priority: 2, priorityBefore: 4, title: "Retry failed charges" }),
      change({ key: "ACME-151", kinds: ["due"], priority: 2, due: "2026-11-26", dueBefore: "2026-11-24", workspace: { workspaceId: "w1", title: "Audit log export" } }),
      change({ key: "ACME-163", kinds: ["lowered"], priority: 4, priorityBefore: 3 }),
      change({ key: "ACME-181", kinds: ["new"], priority: 4 }),
      change({ key: "ACME-182", kinds: ["new"], priority: 4 }),
      change({ key: "ACME-183", kinds: ["new"], priority: 0 }),
      change({ key: "ACME-120", kinds: ["left"], left: { cause: "done", state: "Done", to: null } }),
      change({ key: "ACME-131", kinds: ["left"], left: { cause: "reassigned", state: null, to: "bob" } }),
    ],
  };
  const b = sinceBlock(view, MON, TZ);
  assert.equal(b.title, "Since Friday · your Linear queue");
  assert.equal(b.link, "47 issues by priority");
  assert.ok(b.lines.length <= SINCE_LINES);
  assert.deepEqual(b.lines.map(l => l.head), [
    "ACME-177 new, Urgent", "ACME-142 raised Low → High", "ACME-151 due moved to Thu", "+3 new, Low", "2 left your queue",
  ]);
  assert.equal(b.lines[0]!.meta, "due Wed");
  assert.equal(b.lines[0]!.sub, "Webhook retries ignore the per-endpoint limit · no workspace yet");
  assert.deepEqual(b.lines.map(l => l.source), ["ACME-177", "ACME-142", null, null, null]);
  assert.equal(b.lines[2]!.sub, "Issue ACME-151 · Audit log export has it");
  assert.equal(b.lines[3]!.meta, null, "Low news is its own line, never on another issue's");
  assert.equal(b.lines[4]!.meta, "ACME-120 done, ACME-131 reassigned to bob");
  assert.ok(b.lines[0]!.warn && b.lines[1]!.warn && !b.lines[3]!.warn);
  assert.equal(b.empty, null);
  assert.equal(b.more, 1, "ACME-163's lowering waits in the queue's Changed filter");
  // ACME-142 is a raised Needs-you item with its own Start…: its line keeps the news, not a second set of actions.
  assert.deepEqual(sinceBlock(view, MON, TZ, new Set(["ACME-142"])).lines.map(l => l.source), ["ACME-177", null, null, null, null]);
});

test("the block caps at five lines and counts the rest; nothing changed says so once", () => {
  const many = Array.from({ length: 8 }, (_, n) => change({ key: `ACME-${n + 1}`, kinds: ["raised"], priority: 2, priorityBefore: 3 }));
  const b = sinceBlock({ since: null, counts: { all: 8 }, changes: many }, MON, TZ);
  assert.equal(b.lines.length, SINCE_LINES);
  assert.equal(b.more, 3);
  assert.equal(b.title, "Your Linear queue");
  const quiet = sinceBlock({ since: "2026-11-20T22:00:00.000Z", counts: { all: 1 }, changes: [] }, MON, TZ);
  assert.deepEqual([quiet.lines.length, quiet.empty, quiet.link], [0, "Nothing moved in your queue since Friday.", "1 issue by priority"]);
});

test("queue chips and the Needs-you row say the change in a few words", () => {
  assert.deepEqual(changeChip(change({ key: "A-1", kinds: ["raised"], priority: 2, priorityBefore: 4 }), MON, TZ), { icon: "ArrowUp", text: "Low → High", warn: true });
  assert.deepEqual(changeChip(change({ key: "A-1", kinds: ["new"] }), MON, TZ), { icon: "Plus", text: "New", warn: false });
  assert.deepEqual(changeChip(change({ key: "A-1", kinds: ["due"], due: "2026-11-26", dueBefore: "2026-11-24" }), MON, TZ), { icon: "Calendar", text: "Due moved to Thu", warn: false });
  // The row's meta leaves the due to a chip that already says it moved.
  assert.equal(queueRowMeta({ state: "Todo", due: "2026-11-26" }, MON, TZ, { kinds: ["due"] }), "Todo");
  assert.equal(queueRowMeta({ state: "Todo", due: "2026-11-26" }, MON, TZ, { kinds: ["new"] }), "Todo · due Thu");
  assert.equal(changeChip(null, MON, TZ), null);
  assert.deepEqual(raisedRow({ key: "ACME-142", title: "Retry failed charges", url: null, priority: 2, priorityBefore: 4, due: null, at: "x" }, MON, TZ),
    { title: "ACME-142", word: "Raised", line: "Low → High · Retry failed charges · no workspace yet", label: "ACME-142 raised Low → High. Retry failed charges · no workspace yet" });
});

// ---------- decision Q8, through the real store ----------

type Raw = { key: string; priority: number };
const issue = (r: Raw): LinearIssue => toLinearIssue({ id: r.key, title: `Issue ${r.key}`, priority: { value: r.priority, name: "x" }, status: "Todo", statusType: "unstarted", dueDate: null,
  team: { name: "Acme" }, url: `https://linear.example/acme/issue/${r.key}`, updatedAt: "2026-11-20T10:00:00.000Z" }, true)!;
function reader(issues: Raw[]): QueueReader & { set(next: Raw[]): void } {
  let now = issues;
  return {
    set(next) { now = next; },
    async queuePage(state) { return { issues: state === "unstarted" ? now.map(issue) : [], next: null, readable: true, whole: true }; },
    async leftIssue() { return null; },
    async viewerId() { return "user-alice"; },
  };
}
async function setup(t: TestContext, r: QueueReader, workspaces = new Map<string, { workspaceId: string; title: string }>()) {
  const directory = await mkdtemp(join(tmpdir(), "brief-since-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const time = { now: MON - 72 * H };
  const store = testStore(LinearQueueStore, directory);
  const queue = new LinearQueue({ store, linear: r, clock: async () => CLOCK, now: () => time.now, workspaces: async () => workspaces });
  return { queue, store, time, directory };
}

test("Q8: a raise to Urgent or High with no workspace is a dismissible Needs-you item that a new raise brings back (fails on main: no raised items)", async t => {
  const r = reader([{ key: "ACME-142", priority: 4 }, { key: "ACME-151", priority: 4 }, { key: "ACME-163", priority: 3 }]);
  const workspaces = new Map([["ACME-151", { workspaceId: "w1", title: "Audit log export" }]]);
  const { queue, time, directory } = await setup(t, r, workspaces);
  await queue.sweepNow("manual");
  // Over the weekend: ACME-142 Low → High (no workspace), ACME-151 Low → Urgent (has one), ACME-163 Medium → Low.
  time.now = MON - 2 * H;
  r.set([{ key: "ACME-142", priority: 2 }, { key: "ACME-151", priority: 1 }, { key: "ACME-163", priority: 4 }]);
  await queue.sweepNow("manual");
  const view = await queue.view({});
  assert.deepEqual(view.raised.map(n => [n.key, n.priorityBefore, n.priority]), [["ACME-142", 4, 2]]);

  // Reading the queue (an agent's linear_queue) never dismisses it; the developer's x does, and Undo brings it back.
  assert.deepEqual(await queue.dismissRaise("ACME-142", false), { name: "ACME-142" });
  assert.deepEqual((await queue.view({})).raised, []);
  await assert.rejects(queue.dismissRaise("ACME-142", false), /already gone from Needs you/);
  await queue.dismissRaise("ACME-142", true);
  assert.deepEqual((await queue.view({})).raised.map(n => n.key), ["ACME-142"]);
  await queue.dismissRaise("ACME-142", false);
  const file = JSON.parse(await readFile(join(directory, "linear-queue.json"), "utf8"));
  assert.deepEqual(file.dismissed.map((d: { key: string }) => d.key), ["ACME-142"]);

  // Lowered and raised again: a new raise, so it is back.
  time.now = MON - 1 * H; r.set([{ key: "ACME-142", priority: 4 }, { key: "ACME-151", priority: 1 }, { key: "ACME-163", priority: 4 }]);
  await queue.sweepNow("manual");
  time.now = MON; r.set([{ key: "ACME-142", priority: 1 }, { key: "ACME-151", priority: 1 }, { key: "ACME-163", priority: 4 }]);
  await queue.sweepNow("manual");
  assert.deepEqual((await queue.view({})).raised.map(n => [n.key, n.priority]), [["ACME-142", 1]]);

  // A workspace for it ends the item without a dismissal.
  workspaces.set("ACME-142", { workspaceId: "w2", title: "Billing retries" });
  assert.deepEqual((await queue.view({})).raised, []);
});

test("Q8 is pure over the log: a raise taken back, or an issue that left, is no item", () => {
  const log: LogEntry[] = [
    { at: "2026-11-21T12:00:00.000Z", key: "ACME-1", title: "a", url: null, before: { priority: 4, due: null, state: "Todo" }, after: { priority: 2, due: null, state: "Todo" }, left: null },
    { at: "2026-11-22T12:00:00.000Z", key: "ACME-1", title: "a", url: null, before: { priority: 2, due: null, state: "Todo" }, after: { priority: 4, due: null, state: "Todo" }, left: null },
    { at: "2026-11-21T12:00:00.000Z", key: "ACME-2", title: "b", url: null, before: { priority: 3, due: null, state: "Todo" }, after: { priority: 1, due: null, state: "Todo" }, left: null },
  ];
  const sweeps = [{ at: "2026-11-22T12:00:00.000Z", complete: true, pages: 1, issues: {} }];
  assert.deepEqual(raisedNeeds({ log, sweeps, dismissed: [] }, () => false), [], "ACME-1 went back to Low; ACME-2 left the snapshot");
});

test("Q8's dismiss is follow.dismiss with issue, and dismiss_item carries it for agents (agent parity)", () => {
  assert.ok(dismissRpc.input.safeParse({ issue: "ACME-142" }).success);
  assert.ok(dismissRpc.input.safeParse({ issue: "ACME-142", undo: true }).success);
  assert.ok(!dismissRpc.input.safeParse({ issue: "ACME-142", agentId: "a1" }).success, "one target only");
  assert.ok(!dismissRpc.input.safeParse({ issue: "not a key" }).success);
  const tool = RPC_TOOLS.find(x => x.name === "dismiss_item")!;
  assert.deepEqual(tool.toRpc!({ issue: "ACME-142" } as never), { issue: "ACME-142" });
  assert.deepEqual(tool.toRpc!({ issue: "ACME-142", undo: true } as never), { issue: "ACME-142", undo: true });
});

test("Q8 on Home: raised issues head Needs you and count in it, making the group when no workspace needs the developer", async () => {
  const { listEntries } = await import("../shared/list-entries");
  const { homeCounts } = await import("../shared/home");
  const model = { groups: [], needs: 0, byKey: new Map(), hold: null, raised: 2 } as never;
  const entries = listEntries({ model, closed: new Set(), openProjects: new Set(), pages: {}, briefLine: undefined, results: null, hits: null, filter: null, overseer: false, touch: false, afterNeeds: false });
  assert.deepEqual(entries.map(e => e.type === "header" ? `${e.type}:${e.group}:${e.count}` : e.type), ["header:needs:2", "raised"]);
  assert.equal(homeCounts(model).needs, 2, "the strip's Needs you counts them too");
  // Folded: the header still counts them, the rows hide with the group.
  const closed = listEntries({ model, closed: new Set(["needs"]), openProjects: new Set(), pages: {}, briefLine: undefined, results: null, hits: null, filter: null, overseer: false, touch: false, afterNeeds: false });
  assert.deepEqual(closed.map(e => e.type), ["header"]);
});

test("nobody-s-on-it-is-needs-you: the sidebar badge counts the raised issues from the same model as Home (one server-side count)", async () => {
  const { buildHome, homeCounts } = await import("../shared/home");
  const model = buildHome({ rows: [], tracked: [], paseo: [], now: Date.now(), raised: 1 });
  assert.equal(homeCounts(model).needs, 1, "a raise alone makes Needs you 1");
  // Home and the sidebar item both count homeCounts(useHomeModel(...)), and useHomeModel takes the worker's raised list
  // from the home feed's store: no per-surface read that could disagree or go stale.
  const live = await readFile(new URL("../client/live.tsx", import.meta.url), "utf8");
  assert.match(live, /const count = homeCounts\(useHomeModel\(sources\)\)\.needs;/);
  const data = await readFile(new URL("../client/home-data.ts", import.meta.url), "utf8");
  assert.match(data, /extras\.queue\(\)\.needs\.length/);
  assert.match(data, /buildHome\(\{[^}]*raised[,} ]/);
  const home = await readFile(new URL("../client/home.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(home, /useRaised|linearQueueRpc/, "Home reads no queue of its own for Needs you");
});

test("nobody-s-on-it-is-needs-you: the worker's needs() is the home feed's answer; a sweep that raises an issue changes it and calls onChange (the feed's push)", async t => {
  const r = reader([{ key: "ACME-142", priority: 4 }]);
  const directory = await mkdtemp(join(tmpdir(), "brief-since-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const time = { now: MON - 72 * H };
  let changes = 0;
  const queue = new LinearQueue({ store: testStore(LinearQueueStore, directory), linear: r, clock: async () => CLOCK, now: () => time.now, workspaces: async () => new Map(), onChange: () => { changes++; } });
  await queue.sweepNow("manual");
  const before = await queue.needs();
  assert.deepEqual(before.raised, []);
  time.now = MON - 2 * H;
  r.set([{ key: "ACME-142", priority: 2 }]);
  const pushed = changes;
  await queue.sweepNow("manual");
  assert.ok(changes > pushed, "the sweep told the feed");
  const after = await queue.needs();
  assert.deepEqual(after.raised.map(n => n.key), ["ACME-142"]);
  assert.notEqual(after.revision, before.revision, "the revision moves, so an open brief pane re-reads");
  assert.equal(after.timeZone, CLOCK.timeZone);
});

test("a queue row's opened line: by whom, then how long ago (relative under two weeks, else a date), the exact time in the label", () => {
  // MON is 08:40 on Monday 2026-11-23 in New York.
  assert.equal(openedAge("2026-11-23T12:00:00.000Z", MON, TZ)?.age, "today");
  assert.equal(openedAge("2026-11-23T03:00:00.000Z", MON, TZ)?.age, "yesterday", "22:00 Sunday in New York, though Monday in UTC");
  assert.equal(openedAge("2026-11-18T15:00:00.000Z", MON, TZ)?.age, "5 days ago");
  assert.equal(openedAge("2026-11-10T15:00:00.000Z", MON, TZ)?.age, "13 days ago");
  assert.equal(openedAge("2026-11-09T15:00:00.000Z", MON, TZ)?.age, "Nov 9", "two weeks or more: a date");
  assert.equal(openedAge("2025-10-14T15:00:00.000Z", MON, TZ)?.age, "Oct 14, 2025", "another year names it");
  assert.equal(openedAge("2026-11-18T15:04:00.000Z", MON, TZ)?.exact, "Nov 18, 2026 at 10:04");
  assert.equal(openedAge(null, MON, TZ), null);
  assert.equal(openedAge("not a date", MON, TZ), null);

  const at = "2026-11-11T15:04:00.000Z";
  assert.deepEqual(openedLine({ createdAt: at, creator: "Dana" }, false, MON, TZ), { text: "opened by Dana · 12 days ago", label: "Opened by Dana on Nov 11, 2026 at 10:04" });
  assert.deepEqual(openedLine({ createdAt: at, creator: "Alice" }, true, MON, TZ), { text: "opened by you · 12 days ago", label: "Opened by you on Nov 11, 2026 at 10:04" });
  assert.deepEqual(openedLine({ createdAt: at, creator: null }, null, MON, TZ), { text: "opened 12 days ago", label: "Opened on Nov 11, 2026 at 10:04" }, "no creator: the age alone");
  assert.deepEqual(openedLine({ createdAt: null, creator: "Sam" }, false, MON, TZ), { text: "opened by Sam", label: "Opened by Sam" });
  assert.equal(openedLine({ createdAt: null, creator: null }, null, MON, TZ), null, "a snapshot from before: nothing");
});
