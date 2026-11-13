import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { needsYou, type NeedItem } from "../shared/attention";
import { pickBrief, prStates } from "../shared/brief";
import { linkify } from "../shared/links";
import { prLink, prLinksByNumber } from "../shared/presentation";
import { emptyReviewerConfig, setReviewerConfig } from "../shared/reviewers";
import { rowPrs } from "../server/agent-actions";
import { newEntry, reduce, prEndEvent } from "../shared/inbox";
import type { Pr, State } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

/**
 * a-row-that-names-a-pr-opens-it-in-one-click (2026-11-13): the Needs you row "#1630 is approved" / its title /
 * [Merge #1630] had no way to open #1630; its one button opened Follow-up's merge flow, and the link sat at the bottom
 * of the PR sheet. Rows carried prKey and number but no link. Now every Needs-you item about one PR carries `pr` (the
 * row draws an "Open pull request #N" link beside its action), every "#N" a surface's text names links that PR, every
 * brief about a PR has Open PR, and inbox_list hands an agent the same url.
 */
const at = new Date(clock).toISOString();
const reviewers = { author: "agent-author", requested: [] as string[], teams: [] as string[], reviewed: [] as string[], complete: true };
const approved = (n: number, patch: Partial<Pr> = {}) => pr({ key: `example/app#${n}`, number: n, snapshot: snapshot({ url: `https://github.com/example/app/pull/${n}`, reviewDecision: "APPROVED", title: `PR ${n}`, prWorkflow: "github", mergeStateStatus: "CLEAN" }), ...patch });
const graphite = (n: number) => pr({ key: `example/app#${n}`, number: n, snapshot: snapshot({ url: `https://github.com/example/app/pull/${n}`, reviewDecision: "APPROVED", prWorkflow: "graphite", graphiteMergeStatus: "READY_TO_MERGE" } as never) });

/** Every Needs-you kind that is about one PR, each built the way the app builds it. */
function prItems(t: { after: (fn: () => void) => void }): { name: string; w: ReturnType<typeof workspace>; item: NeedItem; prNumber: number }[] {
  setReviewerConfig({ ...emptyReviewerConfig(), repos: { "example/app": [{ login: "ravi", name: "Ravi" }] } });
  t.after(() => setReviewerConfig(emptyReviewerConfig()));
  const out: { name: string; w: ReturnType<typeof workspace>; item: NeedItem; prNumber: number }[] = [];
  const pick = (name: string, w: ReturnType<typeof workspace>, kind: NeedItem["kind"], prNumber: number) => {
    const item = needsYou(w, clock).find(i => i.kind === kind);
    assert.ok(item, `${name}: no ${kind} item drawn`);
    out.push({ name, w, item: item!, prNumber });
  };
  pick("merge (GitHub)", workspace({ prs: [approved(1630)] }), "merge", 1630);
  pick("reviewers", workspace({ prs: [pr({ key: "example/app#1631", number: 1631, registeredAgentId: "main-agent", snapshot: snapshot({ url: "https://github.com/example/app/pull/1631", reviewers, checksPending: true, prWorkflow: "github" }) })] }), "reviewers", 1631);
  const task = { key: "conflict:example/app#1632", kind: "conflict", target: "example/app#1632", title: "Resolve conflicts on #1632", fingerprint: "f" };
  pick("capped repair", workspace({ prs: [pr({ key: "example/app#1632", number: 1632, snapshot: snapshot({ url: "https://github.com/example/app/pull/1632", conflict: true, prWorkflow: "github" }) })], heldTasks: [{ task: task as never, held: "capped" }] }), "capped", 1632);
  pick("uncertain merge (check)", workspace({ prs: [approved(1633)], prActions: [{ id: "a", kind: "merge", prs: ["example/app#1633"], heads: {}, createdAt: at, state: "uncertain", result: "GitHub didn't answer" }] as never }), "check", 1633);
  return out;
}

test("pr-open-link: every Needs-you item about one PR carries its link, labelled for a screen reader", t => {
  const items = prItems(t);
  assert.deepEqual(items.map(i => i.item.kind), ["merge", "reviewers", "capped", "check"]);
  for (const { name, item, prNumber } of items) {
    assert.ok(item.pr, `${name}: no link to #${prNumber}`);
    assert.equal(item.pr!.url, `https://github.com/example/app/pull/${prNumber}`, name);
    assert.equal(item.pr!.label, `Open pull request #${prNumber}`, name);
    // The row's own text names the PR, and that "#N" links the same PR.
    const runs = linkify(`${item.title} ${"detail" in item ? item.detail : ""}`, prLinksByNumber([...needsYouWs(items, name).prs]));
    const named = runs.filter(r => r.text === `#${prNumber}`);
    assert.ok(named.length >= 1, `${name}: "#${prNumber}" isn't in the row's text`);
    for (const r of named) assert.deepEqual([r.url, r.label], [item.pr!.url, item.pr!.label], `${name}: "#${prNumber}" in the text links elsewhere`);
  }
});
const needsYouWs = (items: ReturnType<typeof prItems>, name: string) => items.find(i => i.name === name)!.w;

test("pr-open-link: every surface that draws Needs-you rows renders the link beside the action, never as it", async () => {
  const src = await readFile(join(import.meta.dirname, "../client/needs-you.tsx"), "utf8");
  // NeedsYouList is the one renderer: the panel's and Home's Needs you block, and the composer pill's sheet.
  assert.match(src, /item\.pr \? <PrLinkButton link=\{item\.pr\}/);
  assert.match(src, /<>\{act\}\{link\}<\/>/, "the link sits after the row's action");
  assert.match(src, /<PrLinksProvider prs=\{prLinksByNumber\(w\.prs\)\}>/, "the rows' text links the PRs it names");
  for (const surface of ["pill.tsx", "home.tsx", "panel.tsx"]) {
    const s = await readFile(join(import.meta.dirname, "../client", surface), "utf8");
    assert.match(s, /<NeedsYou(List|Block) /, `${surface} draws Needs you through NeedsYouList`);
  }
  const kit = await readFile(join(import.meta.dirname, "../client/kit.tsx"), "utf8");
  assert.match(kit, /accessibilityRole="link" accessibilityLabel=\{link\.label\}/);
  assert.match(kit, /href: link\.url/);
  const brief = await readFile(join(import.meta.dirname, "../client/brief.tsx"), "utf8");
  assert.match(brief, /<PrLinksProvider prs=\{prs\}><BriefCardBody/, "brief cards (the done brief too) link the PRs they name");
  const questions = await readFile(join(import.meta.dirname, "../client/questions.tsx"), "utf8");
  assert.match(questions, /<PrLinksProvider prs=\{prLinksByNumber\(\[pr\]\)\}><RichText[^>]*>\{`About #\$\{pr\.number\}/, "a question's \"About #142\" links #142");
});

test("pr-open-link: a Graphite repository's PR opens in Graphite; a GitHub one on GitHub", () => {
  assert.equal(prLink(graphite(7)).url, "https://app.graphite.com/github/pr/example/app/7");
  assert.equal(prLink(approved(7)).url, "https://github.com/example/app/pull/7");
  assert.equal(prLink(pr({ key: "example/app#9", number: 9 })).url, "https://app.graphite.com/github/pr/example/app/9", "no workflow recorded: Graphite, as the PR sheet");
  assert.equal(prLink(pr({ key: "example/app#8", number: 8, snapshot: null })).url, "https://github.com/example/app/pull/8", "no read yet: GitHub");
});

test("pr-open-link: a bare #N links only a PR the workspace tracks, and never an ambiguous one", () => {
  const prs = prLinksByNumber([approved(240), approved(12), pr({ key: "example/web#12", repo: "example/web", number: 12 })]);
  const runs = linkify("Nothing needed: #240 is merged. See #12 and #999, issue#240, a/b#240.", prs);
  assert.deepEqual(runs.filter(r => r.url).map(r => [r.text, r.label]), [["#240", "Open pull request #240"], ["a/b#240", undefined]]);
  assert.deepEqual(linkify("#240 merged").filter(r => r.url), [], "no workspace, no guess");
});

test("pr-open-link: every brief about a PR offers Open PR", () => {
  const pr240 = approved(240, { registeredAgentId: "main-agent" });
  const states = prStates(workspace({ prs: [pr240] }));
  for (const kind of ["review", "action", "decision"] as const) {
    const b = pickBrief({ agent: { ask: "Look at #240", kind, links: [{ label: "the PR", pr: "example/app#240" }], ...(kind === "decision" ? { decisions: [{ question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }] } : {}) }, pr: states[0], prs: states });
    assert.ok(b.moves.some(m => m.kind === "open_pr" && m.url === "https://github.com/example/app/pull/240"), `${kind} brief has no Open PR`);
  }
  const r = pickBrief({ reviewers: { prKey: "example/app#240", repo: "example/app", number: 240, url: prLink(pr240).url, names: ["Ravi"] } });
  assert.ok(r.moves.some(m => m.kind === "open_pr"));
});

test("pr-open-link: inbox_list gives an agent each flagged PR's url (agent parity)", t => {
  const [merge] = prItems(t);
  const merged = pr({ key: "example/app#92", number: 92, snapshot: snapshot({ state: "MERGED", url: "https://github.com/example/app/pull/92", prWorkflow: "github" }) });
  const w = { ...merge.w, prs: [...merge.w.prs, merged] };
  const end = prEndEvent(merged as never)!;
  const needs = reduce(newEntry("main-agent"), end, at).needs;
  const state = { workspaces: [w] } as unknown as State;
  const got = rowPrs(state, { agentId: "main-agent", workspaceId: w.id, needs } as never, clock);
  assert.deepEqual(got.map(p => [p.number, p.url]).sort((a, b) => Number(a[0]) - Number(b[0])), [[92, "https://github.com/example/app/pull/92"], [1630, "https://github.com/example/app/pull/1630"]]);
});

test("pr-open-link: the invariant holds on every PR row and names a row without its link", async t => {
  const { INVARIANTS } = await import("../shared/status-invariants");
  const inv = INVARIANTS.find(i => i.id === "a-row-that-names-a-pr-opens-it-in-one-click")!;
  for (const { name, w } of prItems(t)) assert.equal(inv.check(w, clock), null, name);
  // A Graphite PR's merge row links Graphite, as its PR sheet does.
  assert.equal(needsYou(workspace({ prs: [graphite(1634)] }), clock).find(i => i.kind === "merge")?.pr?.url, "https://app.graphite.com/github/pr/example/app/1634");
});
