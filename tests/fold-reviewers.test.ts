import test from "node:test";
import assert from "node:assert/strict";
import { needsYou } from "../shared/attention";
import { pickBrief } from "../shared/brief";
import { flagHeadline } from "../shared/headline";
import { needsYouBlock } from "../shared/needs-block";
import { newEntry, reduce, type InboxRow } from "../shared/inbox";
import { emptyReviewerConfig, setReviewerConfig } from "../shared/reviewers";
import { reviewersBriefViolations } from "../shared/status-invariants";
import { clock, pr, snapshot, workspace } from "./fixtures";

/**
 * one-reviewers-ask-per-pr (2026-11-12, the #147 renders): a PR without reviewers asked twice in Needs you, Follow-up's
 * brief "Add reviewers to #240: Ravi" and the row "#240 has no reviewers", and counted 2 for one thing. The row now
 * names the suggested reviewer and the brief folds into it, as #143 folded a brief into its question: one ask per PR,
 * count 1, the same words on the panel, Home's detail pane and the Home row.
 */
const reviewers = (author = "agent-author") => ({ author, requested: [] as string[], teams: [] as string[], reviewed: [] as string[], complete: true });
const unreviewed = (number = 240, author?: string) => pr({ key: `example/app#${number}`, number, snapshot: snapshot({ reviewers: reviewers(author), checksPending: true }), registeredAgentId: "main-agent" });
function fresh(t: { after: (fn: () => void) => void }, names: { login: string; name: string | null }[] = [{ login: "ravi", name: "Ravi" }]) {
  setReviewerConfig({ ...emptyReviewerConfig(), repos: { "example/app": names } });
  t.after(() => setReviewerConfig(emptyReviewerConfig()));
}
function rowFor(number: number, names: string[]): Pick<InboxRow, "agentId" | "needs" | "snooze" | "brief"> {
  const at = new Date(clock).toISOString();
  const brief = pickBrief({ reviewers: { prKey: `example/app#${number}`, repo: "example/app", number, url: null, names } });
  return { agentId: "main-agent", snooze: null,
    needs: reduce(newEntry("main-agent"), { type: "reviewers", dedupeKey: `example/app#${number}:reviewers`, detail: `#${number}`, prKey: `example/app#${number}`, url: null, names }, at).needs,
    brief: { kind: "reviewers", source: "followup", state: "open", ask: brief.ask, prKey: `example/app#${number}` } };
}

test("one-reviewers-ask-per-pr: Follow-up's reviewers brief folds into its PR's row, which names the suggested reviewer; Needs you counts 1", t => {
  fresh(t);
  const items = needsYou(workspace({ mainAgentId: "main-agent", prs: [unreviewed()] }), clock);
  const row = rowFor(240, ["Ravi"]);
  const item = items.find(i => i.kind === "reviewers")!;
  assert.equal(item.title, "Add reviewers to #240: Ravi", "the row says the suggested reviewer");
  assert.equal(item.title, row.brief!.ask, "and the brief's words, so the Home row and the panel agree");
  // Under the label "Add reviewers #240" the headline says only what's new (a-headline-says-only-what-is-new).
  assert.equal(flagHeadline(row, clock, items)?.line, "Suggested: Ravi");
  const block = needsYouBlock(items, { questionIds: [], kind: "reviewers", prKey: "example/app#240" });
  assert.deepEqual(block.cards, [], "no brief card beside the row");
  assert.equal(block.count, 1, "one ask, counted once");
  assert.deepEqual(reviewersBriefViolations(row, items), []);
});

test("one-reviewers-ask-per-pr holds with nobody to suggest, the author excluded, two PRs, and a brief for another PR", t => {
  fresh(t);
  const failures: string[] = [];
  const cases: [string, ReturnType<typeof unreviewed>[], number, string[]][] = [
    ["suggested", [unreviewed()], 240, ["Ravi"]],
    ["author is the reviewer", [unreviewed(240, "ravi")], 240, []],
    ["two PRs", [unreviewed(240), unreviewed(241)], 241, ["Ravi"]],
  ];
  for (const [label, prs, number, names] of cases) {
    const items = needsYou(workspace({ mainAgentId: "main-agent", prs }), clock);
    for (const v of reviewersBriefViolations(rowFor(number, names), items)) failures.push(`${label}: ${v.detail}`);
    const block = needsYouBlock(items, { questionIds: [], kind: "reviewers", prKey: `example/app#${number}` });
    if (block.count !== prs.length) failures.push(`${label}: counts ${block.count} for ${prs.length} PRs`);
  }
  // A reviewers brief for a PR with no row here (already reviewed) still shows: it is the only ask for it.
  const other = needsYouBlock(needsYou(workspace({ mainAgentId: "main-agent", prs: [unreviewed(240)] }), clock), { questionIds: [], kind: "reviewers", prKey: "example/app#999" });
  if (!other.cards.some(c => c.kind === "brief")) failures.push("a brief for a PR without a row lost its card");
  assert.deepEqual(failures, []);
  assert.equal(needsYou(workspace({ mainAgentId: "main-agent", prs: [unreviewed(240, "ravi")] }), clock).find(i => i.kind === "reviewers")?.title, "#240 has no reviewers", "nobody left to suggest (the author): the plain row");
});
