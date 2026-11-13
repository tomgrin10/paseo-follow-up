import test from "node:test";
import assert from "node:assert/strict";
import { echoedItems, flagHeadline, HEADLINE_WORD } from "../shared/headline";
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
