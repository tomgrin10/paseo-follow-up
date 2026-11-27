// Invariant pr-scale-lists-batch-not-throw: a workspace far bigger than any real one (4x the busiest seen: one stack of
// 65 PRs) runs through status, the panel, Home, PR actions, pr-workspaces and agent tool inputs without a schema
// error, and a schema error that does happen reaches people as a plain sentence. Synthetic data only (example/app).
import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { Store } from "../server/store";
import { PrActions } from "../server/pr-actions";
import { BrowserBridge } from "../server/browser-bridge";
import { BROWSER_BATCH, browserBatches, browserCommandSchema, prRefs, type BrowserCommand } from "../shared/pr-actions";
import { errorText, isSchemaError, plainError } from "../shared/errors";
import { TOOL_INPUT } from "../server/agent-actions";
import { refineTasksRpc } from "../shared/contracts";
import { rankReplySchema, reasonReplySchema } from "../shared/ranker";
import { planReplySchema } from "../server/ranker";
import { buildHome, briefPane } from "../shared/home";
import { listEntry } from "../shared/list";
import { agentCard } from "../shared/status";
import { activity } from "../shared/activity";
import { violations } from "../shared/status-invariants";
import { browserWorkspaces, prClaims } from "../server/pr-owner";
import type { Pr, Snapshot, State, Workspace } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

/** 4x the busiest real workspace's PR count. */
const STACK = 260;
const repoMerge = { methods: ["squash", "merge"] as ("squash" | "merge" | "rebase")[], preferred: "squash" as const, autoMerge: true, mergeQueue: false };

/** One stack of `n` open PRs, bottom first, numbered from `from` (five digits: long result texts). */
function stack(n: number, o: { repo?: string; from?: number; github?: boolean } = {}): Pr[] {
  const repo = o.repo ?? "example/app", from = o.from ?? 10_000;
  return Array.from({ length: n }, (_, i) => {
    const number = from + i;
    const extra: Partial<Snapshot> = o.github ? { prWorkflow: "github", mergeStateStatus: "CLEAN", repoMerge } : { graphiteMergeStatus: i ? "READY_TO_MERGE_AS_STACK" : "READY_TO_MERGE" };
    return pr({ key: `${repo}#${number}`, repo, number, stack: "Big rollout", parent: i ? `${repo}#${number - 1}` : null,
      snapshot: snapshot({ title: `Step ${i + 1}`, url: `https://github.com/${repo}/pull/${number}`, head: `head-${number}`, headBranch: `step-${number}`, base: i ? `step-${number - 1}` : "main", reviewDecision: "APPROVED", ...extra }) });
  });
}
/** The big workspace: the long stack plus many short stacks across other repositories. */
function bigWorkspace(o: { github?: boolean } = {}): Workspace {
  const others = Array.from({ length: 12 }, (_, r) => stack(6, { repo: `example/svc-${r}`, from: 500 + r * 10, github: o.github })).flat();
  return workspace({ prs: [...stack(STACK, { github: o.github }), ...others], updatedAt: new Date(clock).toISOString() });
}

/** A Send to Paseo extension stand-in that rejects any command its own schema would (at most BROWSER_BATCH PRs). */
function extension(browser: BrowserBridge) {
  const sizes: number[] = []; const enabled = new Set<number>(); const rejected: string[] = [];
  browser.exchange("browser", true, [], true, ["example/app"]);
  const poll = setInterval(() => {
    for (const job of browser.exchange("browser", true, [], true, ["example/app"]).jobs) {
      const parsed = browserCommandSchema.safeParse(job);
      if (!parsed.success) { rejected.push(job.id); continue; }
      sizes.push(job.prs.length);
      if (job.op !== "read") for (const p of job.prs) { if (job.op === "enable_mwr") enabled.add(p.number); else enabled.delete(p.number); }
      browser.exchange("browser", true, [{ id: job.id, nonce: job.nonce, outcome: "completed", prs: job.prs.map(p => ({ repo: job.repo, number: p.number, head: p.head, state: "OPEN" as const, mergeWhenReady: enabled.has(p.number), merging: false })), applied: job.op === "read" ? [] : job.prs.map(p => p.number), error: "" }], true, ["example/app"]);
    }
  }, 2);
  return { sizes, enabled, rejected, stop: () => clearInterval(poll) };
}

async function fixture(w: Workspace) {
  const root = await mkdtemp(join(tmpdir(), "follow-scale-")); const store = testStore(Store, root);
  await store.mutate(s => s.workspaces.push(w));
  const calls: string[] = [];
  const github = {
    observe: async (prs: Pr[]) => new Map(w.prs.filter(p => prs.some(q => q.key === p.key)).map(p => [p.key, { snapshot: p.snapshot, error: p.error }])),
    merge: async (p: Pick<Pr, "number">) => { calls.push(`merge #${p.number}`); },
    autoMerge: async (p: Pick<Pr, "number">, o: { enable: boolean }) => { calls.push(`auto ${o.enable ? "on" : "off"} #${p.number}`); },
    retarget: async (p: Pick<Pr, "number">) => { calls.push(`retarget #${p.number}`); },
  };
  const browser = new BrowserBridge();
  const actions = new PrActions(store, github as never, { invalidate() {}, merge: async () => undefined }, browser);
  actions.settle = async () => undefined;
  actions.savedMethod = () => "squash";
  return { store, actions, browser, calls, close: async () => { await actions.close(); browser.close(); await rm(root, { recursive: true, force: true }); } };
}
const top = (w: Workspace) => w.prs[STACK - 1]!.key;

test("pr-scale: PR status on a 260-PR stack reads Graphite in batches, never one oversized command", async () => {
  const w = bigWorkspace(); const f = await fixture(w); const ext = extension(f.browser);
  try {
    const status = await f.actions.status(w.id, top(w));
    assert.equal(status.error, null, `status error: ${status.error}`);
    assert.equal(status.pr?.mergeWhenReady, false);
    assert.deepEqual(ext.rejected, []);
    assert.ok(ext.sizes.length >= Math.ceil(STACK / BROWSER_BATCH) && ext.sizes.every(n => n <= BROWSER_BATCH), JSON.stringify(ext.sizes));
  } finally { ext.stop(); await f.close(); }
});

test("pr-scale: merge when ready across the whole 260-PR stack goes as batches and says so in a short result", async () => {
  const w = bigWorkspace(); const f = await fixture(w); const ext = extension(f.browser);
  try {
    const plan = await f.actions.prepare(w.id, top(w), "enable_mwr");
    assert.equal(plan.prs.length, STACK);
    const reply = await f.actions.confirm(plan.id, "downstack");
    assert.equal(reply.state, "submitted", reply.result);
    assert.equal(ext.enabled.size, STACK);
    assert.deepEqual(ext.rejected, []);
    assert.ok(ext.sizes.every(n => n <= BROWSER_BATCH));
    assert.ok(reply.result.length < 300 && /\+\d+ more/.test(reply.result), reply.result);
    const saved = (await f.store.snapshot()).workspaces[0].prActions.at(-1)!;
    assert.equal(saved.prs.length, STACK);
    assert.ok(activity((await f.store.snapshot()).workspaces[0]).every(a => a.text.length < 300));
  } finally { ext.stop(); await f.close(); }
});

test("pr-scale: a batch that fails after earlier batches changed PRs reads as uncertain, not failed", async () => {
  const browser = new BrowserBridge(); browser.exchange("browser", true, [], true, ["example/app"]);
  let n = 0;
  const poll = setInterval(() => {
    for (const job of browser.exchange("browser", true, [], true, ["example/app"]).jobs) {
      const ok = n++ === 0;
      browser.exchange("browser", true, [ok
        ? { id: job.id, nonce: job.nonce, outcome: "completed", prs: job.prs.map(p => ({ repo: job.repo, number: p.number, head: p.head, state: "OPEN" as const, mergeWhenReady: true, merging: false })), applied: job.prs.map(p => p.number), error: "" }
        : { id: job.id, nonce: job.nonce, outcome: "failed", prs: [], applied: [], error: "Graphite refused." }], true, ["example/app"]);
    }
  }, 2);
  try {
    const prs: BrowserCommand["prs"] = Array.from({ length: 120 }, (_, i) => ({ number: i + 1, head: `h${i + 1}`, trunk: "main" }));
    const reply = await browser.request("enable_mwr", "example/app", prs);
    assert.equal(reply.outcome, "uncertain");
    assert.equal(reply.applied.length, BROWSER_BATCH);
    assert.equal(n, 2, "it stops at the first batch that doesn't complete");
  } finally { clearInterval(poll); browser.close(); }
});

test("pr-scale: GitHub-mode auto-merge and merge on a 260-PR stack keep their result inside its text cap", async () => {
  const w = bigWorkspace({ github: true }); const f = await fixture(w);
  try {
    const on = await f.actions.prepare(w.id, top(w), "enable_mwr");
    const reply = await f.actions.confirm(on.id, "downstack");
    assert.equal(reply.state, "submitted", reply.result);
    assert.equal(f.calls.filter(c => c.startsWith("auto on")).length, STACK);
    assert.ok(reply.result.length < 300, reply.result);
    const merge = await f.actions.prepare(w.id, top(w), "merge");
    assert.ok(merge.prs.length === STACK);
  } finally { await f.close(); }
});

test("pr-scale: the panel, Home, pr-workspaces and the status checks build for the big workspace", () => {
  const w = bigWorkspace(); const now = clock + 60_000;
  const entry = listEntry(w); assert.ok(entry);
  agentCard(w, now);
  assert.ok(Array.isArray(activity(w)));
  assert.ok(Array.isArray(violations(w, now)));
  const model = buildHome({ rows: [], tracked: [w], paseo: [], now });
  assert.ok(model.groups.some(g => g.items.length));
  briefPane({ model, rows: [], tracked: [w], now });
  const state = { version: 1, workspaces: [w], workspaceOptOuts: [], migrations: [] } as unknown as State;
  assert.equal(prClaims(state, "example/app", 10_100).length, 1);
  const many = Array.from({ length: 12 }, (_, i) => ({ workspace: { ...w, id: `w${i}` }, agent: { status: "idle" } }));
  const shown = browserWorkspaces(many, now);
  assert.ok(shown.workspaces.length <= 3 && shown.more === many.length - shown.workspaces.length);
});

test("pr-scale: agent tools and RPC inputs take lists the size of the big workspace", () => {
  const w = bigWorkspace();
  assert.ok(TOOL_INPUT.add_reviewers.safeParse({ prs: w.prs.map(p => p.key) }).success, "add_reviewers on every PR");
  assert.ok(TOOL_INPUT.sign_off.safeParse({ agentIds: Array.from({ length: 300 }, (_, i) => `agent-${i}`) }).success);
  assert.ok(TOOL_INPUT.set_priorities.safeParse({ priorities: Array.from({ length: 400 }, (_, i) => ({ workspace: `w${i}`, score: 50, reason: "Big rollout" })) }).success);
  const tasks = Array.from({ length: STACK }, (_, i) => ({ id: `t${i}`, title: `Verify step ${i + 1}`, afterPrs: [w.prs[i]!.key], dependencyStage: "merged" as const, enable_follow_up: true }));
  assert.ok(refineTasksRpc.input.safeParse({ workspaceId: w.id, tasks }).success, "refine-tasks with a task per PR");
});

test("pr-scale: a model reply with too many entries keeps the first ones instead of failing", () => {
  const priorities = Array.from({ length: 1_200 }, (_, i) => ({ workspace: `w${i}`, score: 10, reason: "x y z" }));
  assert.equal(rankReplySchema.parse({ priorities }).priorities.length, 1_000);
  assert.equal(reasonReplySchema.parse({ reasons: priorities }).reasons.length, 1_000);
  assert.equal(planReplySchema.parse({ title: null, items: Array.from({ length: 200 }, (_, i) => `Item ${i}`) }).items.length, 80);
});

test("pr-scale: a schema error reaches people and agents as one plain sentence, its issues in the log", () => {
  // The message Tom saw under a PR's status line, as it crossed the RPC.
  const raw = JSON.stringify([{ origin: "array", code: "too_big", maximum: 50, inclusive: true, path: ["prs"], message: "Too big: expected array to have <=50 items" }], null, 2);
  for (const e of [new Error(raw), new Error(`Request failed: ${raw} requestType=x code=y`), raw]) {
    assert.ok(isSchemaError(e));
    const text = errorText(e);
    assert.ok(!text.includes("{") && !text.includes("Too big"), text);
    assert.match(text, /prs has more than 50 items/);
  }
  const zod = z.object({ prs: z.array(z.number()).max(1) }).safeParse({ prs: [1, 2] }).error!;
  const logged: string[] = [];
  const plain = plainError(zod, d => logged.push(d)) as Error;
  assert.match(plain.message, /^Follow-up couldn't finish this: prs has more than 1 items/);
  assert.equal(logged.length, 1);
  const other = new Error("This PR is already merged.");
  assert.equal(plainError(other, () => assert.fail("not logged")), other);
  assert.equal(errorText(other), "This PR is already merged.");
});

test("pr-scale: prRefs and browserBatches", () => {
  assert.equal(prRefs([1, 2, 3], 2), "#1, #2 +1 more");
  assert.equal(prRefs([1, 2]), "#1, #2");
  assert.deepEqual(browserBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(browserBatches([]), []);
});

/**
 * Every array cap in shared/ and server/ is either a named bound (SCALE, BROWSER_BATCH, a *_MAX/MAX_* constant, or a
 * `truncated` model list) or listed here with why it doesn't grow with a workspace. A new literal cap fails this test
 * until someone decides which it is (invariant pr-scale-lists-batch-not-throw).
 */
const FIXED_CAPS: Record<string, string> = {
  "shared/home-arrange.ts:projects:200": "Display filter the developer picks by hand (home_view); bounds a bad set_display, never grows with a workspace",
  "shared/home-arrange.ts:labels:100": "Display filter the developer picks by hand (home_view); bounds a bad set_display, never grows with a workspace",
  "shared/cards.ts:blocks:CARD_LIMITS.blocks": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:columns:CARD_LIMITS.columns": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:items:CARD_LIMITS.facts": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:items:CARD_LIMITS.files": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:items:CARD_LIMITS.list": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:items:CARD_LIMITS.media": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:labels:CARD_LIMITS.points": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:mark:CARD_LIMITS.codeLines": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:refs:6": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:rows:CARD_LIMITS.columns": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:rows:CARD_LIMITS.rows": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:series:CARD_LIMITS.series": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/cards.ts:values:CARD_LIMITS.points": "a card an agent writes (show_card): refused with the limit named, never grows with a workspace",
  "shared/model.ts:shownCards:CARD_LIMITS.cards": "the workspace's own list of its cards: the card store refuses past CARD_LIMITS.cards (12)",
  "shared/about.ts:links:40": "producer slices to 40 (workspaceLinks, extractLinks)",
  "shared/about.ts:issues:20": "model output about one agent; producer keeps 5",
  "shared/about.ts:failed:6": "one per link source",
  "shared/contracts.ts:repositories:100": "browser exchange (untrusted); browserRepositories slices to 100",
  "shared/contracts.ts:recent:20": "trust-bypass log tail; producer slices",
  "shared/contracts.ts:workspaces:3": "pr-workspaces; browserWorkspaces slices and reports `more`",
  "shared/contracts.ts:options:26": "one question's lettered options",
  "shared/contracts.ts:links:10": "one question's links",
  "shared/contracts.ts:agentIds:500": "agents, not PRs",
  "shared/contracts.ts:choices:10": "one brief's decisions",
  "shared/contracts.ts:agentIds:40": "created-items; the client sends at most 40 per chat",
  "shared/contracts.ts:workspaceIds:40": "created-items; the client sends at most 40 per chat",
  "shared/model.ts:dismissed:100": "producer keeps the last 100 (server/dismiss.ts)",
  "shared/model.ts:undelivered:20": "producer keeps the last 20 (index.server.ts)",
  "shared/pr-actions.ts:results:10": "browser exchange (untrusted): results per poll",
  "shared/pr-actions.ts:repositories:100": "browser exchange (untrusted); browserRepositories slices to 100",
  "shared/pr-workflow.ts:roles:20": "deploy config",
  "shared/pr-workflow.ts:images:20": "deploy config",
  "shared/priorities.ts:sources:5": "one priority's sources",
  "shared/questions.ts:options:26": "one question's lettered options",
  "shared/questions.ts:links:10": "one question's links",
  "shared/queue.ts:sentIds:50": "one message's resend ids; producer keeps the last 50",
  "shared/ranker.ts:sources:5": "one priority's sources (model output, .catch)",
  "shared/ranker.ts:notStarted:20": "model output, .catch([])",
  "shared/linear-queue.ts:workdays:7": "days of the week",
  "shared/morning-brief.ts:workdays:7": "days of the week",
  "shared/morning-brief.ts:states:4": "Linear's four queue state types",
  "shared/morning-brief.ts:unmoved:PLAN_CHANNELS_MAX + 1": "the old plan settings' person and channels, once, at the move",
  "shared/linear-queue.ts:sweeps:2": "the last two complete sweeps; the issues in one are a record, bounded by QUEUE.pagesMax pages",
  "shared/ask.ts:calls:10": "Ask planner's reply (model output); validation keeps ASK.calls",
  "shared/ask.ts:items:20": "Ask summary's reply (model output); validation keeps ASK.items",
  "shared/morning-brief.ts:calls:ASK.calls": "one Ask source's reads, fixed per morning",
  "shared/morning-brief.ts:items:ASK.items": "one Ask source's items, fixed per morning",
  "shared/rename.ts:entries:500": "producer keeps the last 500 (server/rename.ts)",
  "shared/rename.ts:keys:20": "one rename's keys",
  "server/agent-actions.ts:reviewers:15": "reviewers on one PR",
  "server/agent-parity.ts:choices:10": "one brief's decisions",
  "server/agent-parity.ts:agentIds:500": "agents, not PRs",
  "server/ranker.ts:keys:10": "one plan item's keys (.catch)",
  "server/report-issue/index.ts:steps:30": "one bug report",
  "server/report-issue/index.ts:screenshots:6": "one bug report",
  "server/report-issue/index.ts:allow_names:20": "one bug report",
  "shared/compass.ts:people:COMPASS.people": "one Compass source's people (developer config, 5)",
  "shared/compass.ts:places:COMPASS.places": "one Compass source's places (developer config, 5)",
  "shared/compass.ts:roles:ROLES.length": "the fixed list of Compass roles",
  "shared/compass.ts:sources:COMPASS.sources": "Compass sources (developer config, 8)",
  "shared/compass.ts:glossary:COMPASS.glossary": "the developer's glossary entries (config, 40)",
  "shared/compass.ts:keys:10": "one Compass note's issue keys",
  "shared/compass.ts:refused:50": "the last read's refused rule codes",
  "shared/compass.ts:removed:COMPASS.removed": "suggestions the developer removed, trimmed to the newest 200 on every write",
  "shared/compass.ts:notes:40": "one extraction reply's notes (model output; validation keeps notesPerRead)",
  "shared/compass.ts:retracts:20": "one extraction reply's retractions (model output)",
  "shared/compass.ts:seen:COMPASS.docBlocks": "one doc place's read block hashes: a doc is at most 64 KB, and the cursor keeps the newest 400",
  "shared/scale.ts::max": "the truncated() helper itself: its callers pass a SCALE bound",
};
const NAMED = /^(SCALE\.\w+|BROWSER_BATCH|[A-Z][A-Z0-9_]*_MAX|MAX_[A-Z0-9_]+)$/;
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sources(p)); else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}
test("pr-scale: every array cap is a named bound or a listed fixed-size list", async () => {
  const isArray = (e: ts.Expression): boolean => {
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const n = e.expression.name.text;
      if (n === "array" && e.expression.expression.getText() === "z") return true;
      if (["min", "nonempty", "optional", "default", "catch", "nullable"].includes(n)) { e = e.expression.expression; continue; }
      return false;
    }
    return false;
  };
  const found: string[] = []; const unlisted: string[] = [];
  for (const file of [...await sources("shared"), ...await sources("server")]) {
    const src = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "max" && isArray(n.expression.expression)) {
        let p: ts.Node | undefined = n.parent, name = "";
        while (p && !name) { if (ts.isPropertyAssignment(p) || ts.isVariableDeclaration(p)) name = p.name.getText(); p = p.parent; }
        const cap = n.arguments[0]!.getText(), key = `${file}:${name}:${cap}`;
        found.push(key);
        if (!NAMED.test(cap) && !FIXED_CAPS[key]) unlisted.push(`${key} (line ${src.getLineAndCharacterOfPosition(n.getStart()).line + 1})`);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  assert.deepEqual(unlisted, [], "A literal array cap: give it a SCALE bound and batch/truncate where it grows with a workspace, or list it in FIXED_CAPS with why it doesn't.");
  assert.deepEqual(Object.keys(FIXED_CAPS).filter(k => !found.includes(k)), [], "FIXED_CAPS lists a cap that no longer exists");
});
