import test from "node:test";
import assert from "node:assert/strict";
import { echoedItems, flagHeadline, HEADLINE_WORD, todoLine } from "../shared/headline";
import { newEntry, prEndEvent, reduce, REASONS, type InboxRow, type Reason, type ReasonEntry } from "../shared/inbox";
import { prChip } from "../shared/home";

/**
 * say-it-once (2026-11-12): Home's row read "Merged · #240 merged" beside a "#240 merged" PR chip, and the phone sheet's
 * headline said "#240 merged" under "Merged 1m". The headline line (the row's text, the sheet's and popover's ask)
 * never repeats what the word, the pill label or the PR chip already says. A PR-state flag names its PR by title.
 */
const NOW = Date.parse("2026-11-12T10:12:00.000Z");
const AT = "2026-11-12T10:00:00.000Z";
const TITLE = "Stream large invoice exports";

type Snap = { state: "OPEN" | "MERGED" | "CLOSED"; failedChecks?: string[]; threads?: number; conflict?: boolean };
const pr = (s: Snap) => ({
  key: "example/app#240", repo: "example/app", number: 240, disposition: s.state === "CLOSED" ? "abandoned" : null,
  snapshot: { complete: true, state: s.state, title: TITLE, url: null, failedChecks: s.failedChecks ?? [], checksPending: false, draft: false,
    threads: Array.from({ length: s.threads ?? 0 }, (_, i) => ({ id: `t${i}` })), conflict: !!s.conflict },
});

/** Each reason's flag as the daemon raises it (server/inbox.ts followUpEvents, shared/inbox.ts reduce), with its PR. */
function flagged(reason: Reason): { row: InboxRow; snap: Snap } {
  const entry = (detail: string): ReasonEntry => ({ reason, at: AT, detail, dedupeKey: reason });
  let reasons: ReasonEntry[]; let snap: Snap = { state: "OPEN" };
  if (reason === "pr_merged" || reason === "pr_closed") {
    snap = { state: reason === "pr_merged" ? "MERGED" : "CLOSED" };
    const e = reduce(newEntry("a1"), prEndEvent(pr(snap))!, AT);
    reasons = e.needs!.reasons;
  } else if (reason === "ci") { snap = { state: "OPEN", failedChecks: ["test", "lint"] }; reasons = [entry("#240 test, lint")]; }
  else if (reason === "review") { snap = { state: "OPEN", threads: 2 }; reasons = [entry("2 review threads to fix on #240")]; }
  else if (reason === "reviewers") reasons = [entry("#240")];
  else reasons = [entry(`The agent's ${reason} message`)];
  const row = { agentId: "a1", needs: { reasons, since: AT }, snooze: null, brief: null } as unknown as InboxRow;
  return { row, snap };
}

test("say-it-once: for every flag reason the headline line is not the word, the pill label or the PR chip", () => {
  const failures: string[] = [];
  for (const reason of REASONS) {
    const { row, snap } = flagged(reason);
    const h = flagHeadline(row, NOW);
    if (!h) { failures.push(`${reason}: no headline`); continue; }
    const chip = prChip({ prs: [pr(snap)] } as never)!;
    const chipText = [chip.label, chip.checks?.text].filter(Boolean).join(" ");
    const said = [HEADLINE_WORD[h.key], h.label, chipText];
    // Home drops a line that is only the word; anything else it shows must say something new.
    if (h.line !== HEADLINE_WORD[h.key] && said.includes(h.line)) failures.push(`${reason}: line "${h.line}" repeats ${JSON.stringify(said)}`);
  }
  assert.deepEqual(failures, []);
});

test("say-it-once: a merged or closed PR's flag reads its title, and the conflict and review lines say what to fix", () => {
  assert.equal(flagHeadline(flagged("pr_merged").row, NOW)!.line, TITLE);
  assert.equal(flagHeadline(flagged("pr_closed").row, NOW)!.line, TITLE);
  // A flag stored before the title existed keeps its old line (it can't be made up).
  const legacy = { agentId: "a1", needs: { reasons: [{ reason: "pr_merged", at: AT, detail: "#240 merged", dedupeKey: "pr_merged" }], since: AT }, snooze: null, brief: null } as unknown as InboxRow;
  assert.equal(flagHeadline(legacy, NOW)!.line, "#240 merged");
  const conflict = { ...flagged("review").row, needs: { reasons: [{ reason: "review", at: AT, detail: "Merge conflict to fix on #240", dedupeKey: "review" }], since: AT } } as InboxRow;
  assert.equal(flagHeadline(conflict, NOW)!.line, "Merge conflict to fix on #240");
});

test("say-it-once: the pill sheet's one to-do that repeats the headline keeps its controls, not its title", () => {
  type Item = Parameters<typeof echoedItems>[0][number];
  const reviewers = (n: number, names: string[]): Item => ({ kind: "reviewers", key: `reviewers:example/app#${n}`, prKey: `example/app#${n}`, number: n,
    suggested: names, title: names.length ? `Add reviewers to #${n}: ${names.join(" and ")}` : `#${n} has no reviewers`, detail: TITLE });
  const flag = { reason: "reviewers", at: AT, detail: "#246", dedupeKey: "reviewers", prKey: "example/app#246" };
  const brief = (ask: string) => ({ state: "open", kind: "reviewers", source: "followup", ask, moves: [{ kind: "add_reviewers", label: "Add reviewers", prKey: "example/app#246" }] });
  const row = (b: unknown) => ({ agentId: "a1", needs: { reasons: [flag], since: AT }, snooze: null, brief: b } as unknown as InboxRow);
  const surface = (r: InboxRow, items: Item[]) => {
    const h = flagHeadline(r, NOW)!; const echoed = echoedItems(items, h, r);
    return [h.line, ...items.filter(i => !echoed.has(i.key)).map(i => i.title)];
  };
  const repeats = (lines: string[]) => lines.filter((l, i) => lines.findIndex(x => x.trim().toLowerCase() === l.trim().toLowerCase()) !== i);
  // The #156 render: "Add reviewers to #246: Ravi" as the headline and again as the one row.
  const ravi = [reviewers(246, ["Ravi"])];
  assert.deepEqual(surface(row(brief("Add reviewers to #246: Ravi")), ravi), ["Add reviewers to #246: Ravi"]);
  assert.deepEqual(repeats(surface(row(brief("Add reviewers to #246: Ravi")), ravi)), []);
  // The same PR in other words (nobody configured; no brief yet) is still the same ask.
  assert.deepEqual(surface(row(brief("#246 has no reviewers yet")), [reviewers(246, [])]), ["#246 has no reviewers yet"]);
  assert.deepEqual(surface(row(null), ravi), ["Add reviewers to #246"]);
  // Another PR's ask, or a different to-do, keeps its title; #2460 isn't #246.
  const other = [reviewers(2460, ["Ravi"]), reviewers(247, ["Mira"])];
  assert.deepEqual(surface(row(null), other), ["Add reviewers to #246", "Add reviewers to #2460: Ravi", "Add reviewers to #247: Mira"]);
  assert.equal(echoedItems(ravi, null, row(null)).size, 0);
});

test("say-it-once: the popover says its \"N to do\" once: the section header when items show, else the meta line", () => {
  // The 2026-11-13 phone render said "1 to do in this workspace" in the sheet title, the meta line and the section.
  const said = (o: Parameters<typeof todoLine>[0]) => Object.values(todoLine(o)).filter(Boolean).length;
  assert.deepEqual(todoLine({ flagged: true, todo: 1, section: true }), { meta: false, section: true });
  assert.deepEqual(todoLine({ flagged: true, todo: 2, section: false }), { meta: true, section: false }, "items not loaded yet: the meta line carries it");
  for (const flagged of [true, false]) for (const todo of [0, 1, 3]) for (const section of [true, false])
    assert.ok(said({ flagged, todo, section }) <= 1, `${flagged}/${todo}/${section}`);
  assert.deepEqual(todoLine({ flagged: false, todo: 3, section: true }), { meta: false, section: false }, "an unflagged popover lists items without a count");
});

test("a-brief-without-an-ask-never-sits-beside-needs-you: the headline never says No ask stated while Needs you draws items", async () => {
  const { needsYou } = await import("../shared/attention");
  const { developerAnswer } = await import("../server/questions");
  const { questionSchema } = await import("../shared/questions");
  const { workspace, clock } = await import("./fixtures");
  type Item = Parameters<typeof flagHeadline>[2] extends (infer U)[] | undefined ? U : never;
  const none = { state: "open", kind: "unknown", source: "none", ask: "No ask stated. Its last paragraph is right above; nothing is guessed." };
  const drawn: Item[] = [
    { kind: "send", key: "send:b1", batchId: "b1", title: "1 task ready", tasks: ["Fix the lint"], blocker: null } as Item,
    { kind: "decision", key: "decision:pr143", title: "#143 is approved", detail: "" } as unknown as Item,
  ];
  const failures: string[] = [];
  for (const reason of REASONS) {
    const { row: base, snap } = flagged(reason);
    const row = { ...base, brief: none } as unknown as InboxRow;
    const beside = flagHeadline(row, NOW, drawn)!;
    if (beside.line === "No ask stated") failures.push(`${reason}: No ask stated beside ${drawn.length} drawn items`);
    // The reviewers flag is its own ask ("Add reviewers to #240"); a failed check headlines as the tasks to send.
    else if (beside.key === "reviewers" ? beside.line !== "Add reviewers to #240" : beside.key !== "repairs" && beside.line !== drawn[0].title) failures.push(`${reason}: "${beside.line}" is not the top drawn item`);
    const alone = flagHeadline(row, NOW, [])!;
    if (reason !== "finished" && alone.line === "No ask stated") failures.push(`${reason}: No ask stated speaks for a ${reason} flag`);
    if ((reason === "pr_merged" || reason === "pr_closed") && alone.line !== TITLE) failures.push(`${reason}: alone reads "${alone.line}", not the PR title`);
    void snap;
  }
  assert.deepEqual(failures, []);
  // The plain finish with nothing drawn still says so: its card is the row's only word.
  assert.equal(flagHeadline({ ...flagged("finished").row, brief: none } as unknown as InboxRow, NOW, [])!.line, "No ask stated");
  // A real ask always speaks, items or not.
  const ask = { state: "open", kind: "decision", source: "agent", ask: "Pick the export format" };
  assert.equal(flagHeadline({ ...flagged("finished").row, brief: ask } as unknown as InboxRow, NOW, drawn)!.line, "Pick the export format");
  // #163's sent-from-row case: the answer was copied, not sent; Needs you draws it, so the Merged row reads it.
  const w = workspace({ questions: [questionSchema.parse({ id: "Q1", title: "Duplicate contacts?", question: "Update or skip?", askedBy: "main-agent", askedAt: new Date(clock).toISOString(), mode: "stop", options: [{ letter: "A", label: "Update" }] })] });
  developerAnswer(w, "Q1", "A", undefined, "copy", clock);
  const items = needsYou(w, clock);
  const merged = { ...flagged("pr_merged").row, brief: none } as unknown as InboxRow;
  assert.equal(flagHeadline(merged, NOW, items)!.line, items[0].title);
  assert.notEqual(flagHeadline(merged, NOW, items)!.line, "No ask stated");
});
