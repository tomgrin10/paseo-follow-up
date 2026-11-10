import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { flatItems, isMenuKey, laterChoices, RELEASE_TAIL_MS, sheetArmed, LATER_CHOICES, moveFocus, placeMenu, ROW_ACTIONS, rowMenu, type RowMenuInput } from "../shared/row-menu";
import { snoozeUntil } from "../shared/inbox";
import type { NeedItem } from "../shared/attention";
import { AGENT_TOOLS } from "../server/agent-actions";
import { pr, snapshot, workspace } from "./fixtures";

/**
 * Tom (2026-11-10): "when I right click on a workspace in the main dashboard [show] a context menu with quick actions",
 * and "something I would like in the context menu is the 'Later' option". The row menu lists only what applies to the
 * row, quick triage first, and every move maps to an agent tool (parity) and runs through runAction.
 */
const s = { key: "agent:a1", agentId: "a1", workspaceId: "workspace", title: "Migration rollout", agent: null };
const base: RowMenuInput = { s, flagged: false, w: workspace(), needs: [], branch: "tom/migration", canAsk: true };
const keys = (input: RowMenuInput) => rowMenu(input).map(sec => [sec.key, sec.items.map(i => i.key)] as const);
const hold: NeedItem = { kind: "hold", key: "hold", title: "Follow-up is paused", detail: "Paused" };
const send = (blocker: string | null): NeedItem => ({ kind: "send", key: "send:b1", batchId: "b1", title: "Send", tasks: ["Fix lint", "Rebase"], blocker });
const retry = (exhausted: boolean): NeedItem => ({ kind: "retry", key: "retry:b2", batchId: "b2", title: "Retry", detail: "", exhausted });
const question = (id: string): NeedItem => ({ kind: "question", key: `question:${id}`, questionId: id, title: `${id} · Pick a rollout`, detail: "Which one?", state: "stopped", big: null });

test("a flagged row leads with Later, today's four choices, then Sign off", () => {
  const menu = rowMenu({ ...base, flagged: true });
  assert.equal(menu[0].key, "triage");
  const [later, signOff] = menu[0].items;
  assert.equal(later.label, "Later");
  const morning = new Date(2026, 10, 10, 9, 0);
  assert.deepEqual(rowMenu({ ...base, flagged: true, now: morning })[0].items[0].children!.map(c => [c.arg, c.label]), LATER_CHOICES.map(([id, label]) => [id, label]));
  assert.deepEqual(LATER_CHOICES.map(([id]) => id), ["hour", "tonight", "tomorrow", "next-event"], "the same choices as the detail pane and pill");
  for (const [id] of LATER_CHOICES) assert.ok(snoozeUntil(id, new Date()), `${id} goes through snoozeUntil`);
  assert.equal(signOff.action, "sign_off");
  assert.ok(!flatItems(menu).some(i => i.label.includes("& next")), "no Sign off & next: the menu doesn't open the row");
});

test("a quiet or snoozed row has no triage moves", () => {
  assert.ok(!keys(base).some(([k]) => k === "triage"));
  const snoozed = rowMenu({ ...base, flagged: true, snoozedUntil: "Tue 09:00" })[0].items;
  assert.deepEqual(snoozed.map(i => i.action), ["later", "bring_back", "sign_off"], "a snoozed row can change its time, come back now, or be signed off");
  assert.equal(snoozed[1].label, "Bring back now");
  assert.ok(!flatItems(rowMenu({ ...base, flagged: true })).some(i => i.action === "bring_back"), "only a snoozed row comes back");
  assert.equal(snoozed[0].hint, "Later until Tue 09:00", "the same words as the Undo bar and the pane");
  assert.ok(!keys({ ...base, flagged: true, s: { ...s, agentId: null } }).some(([k]) => k === "triage"), "no agent, nothing to snooze");
});

test("fix moves appear only when they apply", () => {
  const all = keys({ ...base, needs: [hold, send(null), retry(false)] }).find(([k]) => k === "fix")!;
  assert.deepEqual(all[1], ["clear_hold", "send_repairs:b1", "retry_batch:b2"]);
  assert.equal(rowMenu({ ...base, needs: [send(null)] }).find(x => x.key === "fix")!.items[0].label, "Send 2 repairs");
  assert.ok(!keys({ ...base, needs: [send("The agent is busy"), retry(true)] }).some(([k]) => k === "fix"), "a blocked send and an exhausted retry are hidden");
  assert.ok(!keys({ ...base, w: null, needs: [hold] }).some(([k]) => k === "fix"), "untracked rows have nothing to fix");
});

test("open questions get an Answer each, at most two", () => {
  const answer = rowMenu({ ...base, needs: [question("Q3"), question("Q4"), question("Q5")] }).find(x => x.key === "answer")!;
  assert.deepEqual(answer.items.map(i => [i.label, i.hint]), [["Answer Q3", "Pick a rollout"], ["Answer Q4", "Pick a rollout"]]);
});

test("copy, Summary, main agent and Stop following", () => {
  const prs = [pr(), pr({ key: "example/app#2", number: 2, snapshot: snapshot({ url: "https://github.com/example/app/pull/2" }) }), pr({ key: "example/app#3", number: 3, snapshot: snapshot({ state: "MERGED", url: "https://github.com/example/app/pull/3" }) })];
  const tidy = rowMenu({ ...base, w: workspace({ prs }) }).find(x => x.key === "tidy")!.items;
  assert.deepEqual(tidy.map(i => i.key), ["copy_branch", "copy_pr", "rewrite_summary", "stop_following"]);
  assert.equal(tidy[1].label, "Copy 2 PR links");
  assert.equal(tidy[1].arg, "https://github.com/example/app/pull/1\nhttps://github.com/example/app/pull/2", "open PRs only");
  assert.ok(tidy[3].confirm, "Stop following asks first");
  const other = rowMenu({ ...base, s: { ...s, agentId: "a2", agent: "Reviewer" } }).find(x => x.key === "tidy")!.items;
  assert.ok(other.some(i => i.action === "make_main" && i.arg === "a2" && i.label === "Make Reviewer the main agent…" && !!i.confirm), "handing over the main role asks first");
  assert.ok(!rowMenu({ ...base, s: { ...s, agentId: "main-agent", agent: "Main" } }).find(x => x.key === "tidy")!.items.some(i => i.action === "make_main"), "already main");
  assert.ok(!flatItems(rowMenu({ ...base, w: workspace({ enable_tracking: false }) })).some(i => i.action === "stop_following"));
  assert.ok(!flatItems(rowMenu({ ...base, canAsk: false })).some(i => i.action === "ask_overseer"));
});

test("nothing destructive without a confirm; no archive or merge in the menu", () => {
  const items = flatItems(rowMenu({ ...base, flagged: true, needs: [hold, send(null), question("Q1")] }), "later");
  for (const i of items) assert.ok(!/archive|merge/i.test(i.label), i.label);
  for (const i of items.filter(i => i.action === "stop_following")) assert.ok(i.confirm);
});

test("parity: every row action names an agent tool, or why it needs none", () => {
  for (const [id, entry] of Object.entries(ROW_ACTIONS)) {
    if ("tool" in entry) assert.ok((AGENT_TOOLS as readonly string[]).includes(entry.tool), `${id}: ${entry.tool} isn't an agent tool`);
    else assert.ok(entry.exempt.length > 10, `${id}: an exemption needs a reason`);
  }
});

test("every row action runs through runAction", async () => {
  const source = await readFile(join("client", "row-actions.ts"), "utf8");
  const body = source.slice(source.indexOf("switch (item.action)"));
  const cases = [...body.matchAll(/case "(\w+)":([\s\S]*?)(?=\n\s*(?:case "|\/\/ |}\n))/g)];
  assert.deepEqual(cases.map(m => m[1]).sort(), Object.keys(ROW_ACTIONS).sort(), "one case per action");
  for (const [, id, code] of cases) assert.match(code, /runAction\(/, `${id} doesn't go through runAction`);
});

test("the browser's menu is replaced on rows only", async () => {
  for (const f of (await readdir("client")).filter(f => /\.tsx?$/.test(f))) {
    const source = await readFile(join("client", f), "utf8");
    for (const m of source.matchAll(/(\w+)(?:\?)?\.addEventListener\("contextmenu"/g)) assert.equal(m[1], "node", `${f}: contextmenu is listened to on ${m[1]}, not a row`);
  }
});

test("menu placement stays inside the viewport", () => {
  const vp = { width: 1000, height: 700 }; const size = { width: 256, height: 300 };
  assert.deepEqual(placeMenu({ x: 100, y: 100 }, size, vp), { left: 100, top: 100 });
  assert.deepEqual(placeMenu({ x: 900, y: 600 }, size, vp), { left: 644, top: 300 }, "flips left and up near the corner");
  assert.deepEqual(placeMenu({ x: 5, y: 5 }, { width: 256, height: 900 }, vp), { left: 8, top: 8 }, "taller than the viewport: pinned to the margin");
});

test("keyboard: arrows wrap, Home and End jump, the menu key and Shift+F10 open", () => {
  assert.equal(moveFocus(0, 4, "ArrowUp"), 3);
  assert.equal(moveFocus(3, 4, "ArrowDown"), 0);
  assert.equal(moveFocus(2, 4, "Home"), 0);
  assert.equal(moveFocus(0, 4, "End"), 3);
  assert.equal(moveFocus(-1, 4, "ArrowDown"), 0, "pointer open: nothing active, Down starts at the top");
  assert.equal(moveFocus(-1, 4, "ArrowUp"), 3);
  assert.ok(isMenuKey({ key: "ContextMenu" }));
  assert.ok(isMenuKey({ key: "F10", shiftKey: true }));
  assert.ok(!isMenuKey({ key: "F10" }));
});

test("the long-press that opens the sheet never picks an item (bug: long-pressing a held row resumed it)", () => {
  assert.equal(sheetArmed(null, 10_000), false, "the opening touch is still down");
  assert.equal(sheetArmed(10_000, 10_000), false, "the lift itself, and its synthesized click");
  assert.equal(sheetArmed(10_000, 10_000 + RELEASE_TAIL_MS - 1), false);
  assert.equal(sheetArmed(10_000, 10_000 + RELEASE_TAIL_MS), true, "a fresh tap after the lift");
});

test("Later after 18:00 has no Tonight: it would land after Tomorrow 09:00", () => {
  assert.deepEqual(laterChoices(new Date(2026, 10, 10, 17, 59)).map(([id]) => id), ["hour", "tonight", "tomorrow", "next-event"]);
  assert.deepEqual(laterChoices(new Date(2026, 10, 10, 18, 0)).map(([id]) => id), ["hour", "tomorrow", "next-event"]);
});
