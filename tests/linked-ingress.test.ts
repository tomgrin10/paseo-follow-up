import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dueChecks, emptyLinkedFile, linkedView, noteRefs, setTeams } from "../shared/linked";
import { timelineRefs, workspaceRefs } from "../shared/linked-extract";
import { FORWARD_PREFIXES, forwardText } from "../shared/overseer";
import { LinkedService, LinkedStore, type LinkedSources } from "../server/linked";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { HistoryCache } from "../server/history-cache";
import { SessionGuard } from "../server/session-guard";
import { DAY_MS } from "../server/agent-load";
import type { State } from "../shared/model";
import { clock, workspace } from "./fixtures";

// Linked items, part 2: what gets in. Explicit links (link_item, the developer's Add link) are validated on the spot;
// passive extraction rides text Follow-up already reads and never reads a dormant agent.

const NOW = Date.parse("2026-11-10T12:00:00Z");
const user = (seq: number, text: string) => ({ seqStart: seq, item: { type: "user_message", text } });
const said = (seq: number, text: string) => ({ seqStart: seq, item: { type: "assistant_message", text } });
const tool = (seq: number, name: string, input: unknown, status = "completed") => ({ seqStart: seq, item: { type: "tool_call", name, status, detail: { input } } });

async function temp(t: any) { const dir = await mkdtemp(join(tmpdir(), "follow-linked-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function fakeLinear(issues: Record<string, string>, down = false) {
  const calls: string[] = [];
  const sources: LinkedSources = {
    async issue(key) { calls.push(key); if (down) throw new Error("mcpproxy: timeout"); return issues[key] ? { title: issues[key], state: "In Progress", url: `https://linear.app/acme/issue/${key}` } : null; },
    async teams() { return ["ACME", "OPS"]; },
  };
  return { sources, calls };
}

test("timeline: receipts and the developer's words are strong, agent prose weak, Follow-up's own text and PRs never count", () => {
  const refs = timelineRefs([
    user(1, "Start from ACME-1312 and https://acme.slack.com/archives/C0ABC/p1731230000123456"),
    said(2, "I think OPS-77 is related. See https://github.com/acme/app/pull/9"),
    tool(3, "mcp__mcpproxy__linear__get_issue", { id: "ACME-1400" }),
    tool(4, "Bash", { command: "git log --grep ACME-999" }),
    tool(5, "mcp__mcpproxy__slack-user__slack_read_thread", { channel_id: "C0DEF", message_ts: "1731230001.000100" }),
    tool(6, "agent_message", { text: "From the lead: OPS-80 too" }),
    user(7, "Workspace Follow-up batch b1: fix ACME-5000"),
    tool(8, "mcp__mcpproxy__linear__get_issue", { id: "ACME-1401" }, "failed"),
  ]);
  const by = Object.fromEntries(refs.map(r => [r.raw, r.strong]));
  assert.equal(by["ACME-1312"], true, "the developer's own message");
  assert.equal(by["https://acme.slack.com/archives/C0ABC/p1731230000123456"], true);
  assert.equal(by["OPS-77"], false, "an agent only mentioning a key is weak");
  assert.equal(by["ACME-1400"], true, "a Linear tool receipt");
  assert.equal(by["https://slack.com/archives/C0DEF/p1731230001000100"], true, "a Slack thread the agent read");
  assert.equal(by["OPS-80"], false, "another agent's message is prose");
  for (const never of ["ACME-999", "ACME-5000", "ACME-1401"]) assert.equal(never in by, false, `${never} must not count`);
  assert.ok(!refs.some(r => r.raw.includes("/pull/")), "PRs have their own card");
  assert.deepEqual(timelineRefs([user(1, "ACME-1"), user(2, "ACME-2")], 1).map(r => r.raw), ["ACME-2"], "the overlap before the cursor is skipped");
  assert.deepEqual(timelineRefs([user(1, forwardText("look at ACME-77"))]), [], "an Overseer forward is Follow-up's own text");
  assert.deepEqual(timelineRefs([user(1, `${FORWARD_PREFIXES.at(-1)} look at ACME-78`)]), [], "so is a forward under the legacy prefix");
});

test("a weak key waits for a second sighting; a strong one goes to Linear now; URL-shaped refs are kept without a check", () => {
  const f = emptyLinkedFile();
  setTeams(f, ["ACME", "OPS"], NOW);
  noteRefs(f, "w1", [{ raw: "OPS-77", strong: false }, { raw: "ACME-1312", strong: true }, { raw: "https://acme.slack.com/archives/C0ABC/p1731230000123456", strong: false }, { raw: "https://example.com/blog", strong: true }], NOW);
  assert.deepEqual(dueChecks(f, NOW).map(d => d.key), ["ACME-1312"]);
  assert.deepEqual(f.workspaces.w1.items.map(i => [i.kind, i.origin]), [["slack", "extracted"]], "a generic URL never gets in by extraction");
  noteRefs(f, "w1", [{ raw: "OPS-77", strong: false }], NOW + 1);
  assert.deepEqual(dueChecks(f, NOW + 1).map(d => d.key).sort(), ["ACME-1312", "OPS-77"], "seen twice: now worth a check");
});

test("link_item: Linear confirms the key first; unknown keys, other teams and PRs are refused with a reason, never stored", async t => {
  const dir = await temp(t);
  const store = new LinkedStore(dir);
  const linear = fakeLinear({ "ACME-1312": "Vendor fix" });
  const svc = new LinkedService({ store, sources: linear.sources, now: () => NOW });
  await store.mutate(f => setTeams(f, ["ACME", "OPS"], NOW));

  const ok = await svc.link("w1", "https://linear.app/acme/issue/ACME-1312/vendor-fix", { origin: "registered", by: "agent-1", why: "the task" });
  assert.ok(ok.ok && !ok.pending && ok.item.title === "Vendor fix" && ok.item.origin === "registered" && ok.item.statusTone === "active");
  const missing = await svc.link("w1", "ACME-99999", { origin: "registered", by: "agent-1" });
  assert.deepEqual(missing, { ok: false, reason: "Linear has no issue ACME-99999." });
  assert.ok((await store.read()).rejected["ACME-99999"], "remembered, so it is never checked again");
  const again = await svc.link("w1", "ACME-99999", { origin: "registered", by: "agent-1" });
  assert.equal(again.ok, false); assert.equal(linear.calls.filter(k => k === "ACME-99999").length, 1);
  const team = await svc.link("w1", "STATUS-1025", { origin: "registered", by: "agent-1" });
  assert.match(!team.ok ? team.reason : "", /STATUS isn't a Linear team/);
  const pr = await svc.link("w1", "https://github.com/acme/app/pull/12", { origin: "registered", by: "agent-1" });
  assert.match(!pr.ok ? pr.reason : "", /register_pr/);
  const doc = await svc.link("w1", "https://example.com/rfc", { origin: "registered", by: "agent-1" });
  assert.ok(doc.ok && !doc.pending && doc.item.kind === "link", "an explicit generic URL is fine");
  assert.deepEqual((await store.read()).workspaces.w1.items.map(i => i.key), ["ACME-1312", "https://example.com/rfc"]);
});

test("Linear unreachable: the linked key waits as a candidate instead of a 'couldn't be read' row", async t => {
  const dir = await temp(t);
  const store = new LinkedStore(dir);
  const svc = new LinkedService({ store, sources: fakeLinear({}, true).sources, now: () => NOW });
  const r = await svc.link("w1", "ACME-7", { origin: "registered", by: "agent-1" });
  assert.ok(r.ok && r.pending);
  const f = await store.read();
  assert.deepEqual(f.workspaces.w1.items, []);
  assert.deepEqual(f.workspaces.w1.candidates.map(c => [c.key, c.strong]), [["ACME-7", true]]);
});

test("unlink sticks against every agent origin; the developer can re-add, and Undo restores the item as it was", async t => {
  const dir = await temp(t);
  const store = new LinkedStore(dir);
  const svc = new LinkedService({ store, sources: fakeLinear({ "ACME-1": "One" }).sources, now: () => NOW });
  await svc.link("w1", "ACME-1", { origin: "registered", by: "agent-1", why: "start" });
  await svc.unlink("w1", "https://linear.app/acme/issue/ACME-1/one", "agent-2", "unrelated");
  const refused = await svc.link("w1", "ACME-1", { origin: "registered", by: "agent-1" });
  assert.match(!refused.ok ? refused.reason : "", /stays out/);
  await svc.note(new Map([["w1", [{ raw: "ACME-1", strong: true }]]]));
  assert.deepEqual((await store.read()).workspaces.w1.candidates, [], "extraction can't bring it back either");
  assert.equal(await svc.undo("w1", "ACME-1"), true);
  const back = (await store.read()).workspaces.w1.items[0];
  assert.equal(back.why, "start"); assert.equal(back.origin, "registered");
  await svc.unlink("w1", "ACME-1", "developer", null);
  const readded = await svc.link("w1", "ACME-1", { origin: "manual", by: "developer" });
  assert.ok(readded.ok && !readded.pending && readded.item.origin === "manual");
});

test("the view derives the spec and published artifacts: the spec is tagged and left out of the counts", () => {
  const f = emptyLinkedFile();
  noteRefs(f, "w1", [{ raw: "https://acme.slack.com/archives/C0ABC/p1731230000123456", strong: true }], NOW);
  f.workspaces.w1.excluded.push({ key: "https://claude.ai/artifact/old", at: "x", by: "developer", reason: null, item: null });
  const view = linkedView("w1", f.workspaces.w1, {
    spec: { url: "https://claude.ai/artifact/spec1", title: "Spec" },
    artifacts: [
      { url: "https://claude.ai/artifact/spec1", title: "Spec", firstAt: null, lastAt: null, by: "a" },
      { url: "https://claude.ai/artifact/report", title: "Report", firstAt: null, lastAt: "2026-11-09T00:00:00Z", by: "a" },
      { url: "https://claude.ai/artifact/old", title: "Old", firstAt: null, lastAt: null, by: "a" },
    ],
  });
  assert.deepEqual(view.items.map(i => [i.kind, i.origin, i.spec]), [["slack", "extracted", false], ["artifact", "spec", true], ["artifact", "published", false]]);
  assert.deepEqual(view.counts, { slack: 1, artifact: 1 });
});

test("the workspace record: goal, title, PR titles and branches are strong sources", () => {
  const refs = workspaceRefs({ goal: "Fix the vendor sync (ACME-1312)", title: "Vendor sync", prs: [{ snapshot: { title: "OPS-4: retry", headBranch: "tom/acme-1400-backoff" } }] });
  assert.deepEqual(refs.map(r => [r.raw, r.strong]), [["ACME-1312", true], ["OPS-4", true], ["ACME-1400", true]]);
});

// ---------- never wake: extraction rides discovery's own reads ----------

const iso = (ms: number) => new Date(ms).toISOString();
const agent = (id: string, workspaceId: string, loaded: boolean): Agent => ({ id, workspaceId, provider: "claude", cwd: "/fixture", createdAt: "2025-12-01T00:00:00Z", status: "idle", labels: {}, lastUserMessageAt: iso(clock - DAY_MS), pendingPermissions: [], ...(loaded ? { activeTurn: null } : {}) } as Agent);

test("extraction never reads a dormant agent, and a cursor re-read never counts as a second sighting", async t => {
  const dir = await temp(t);
  const agents = [agent("live", "w-live", true), agent("asleep", "w-asleep", false)];
  const reads: string[] = [];
  let tail = [said(1, "Maybe OPS-77 matters"), user(2, "Work on ACME-1312")];
  const client = {
    fetchAgents: async () => ({ entries: agents.map(a => ({ agent: a })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: ["w-live", "w-asleep"].map(id => ({ id, name: id, projectId: "project" })), pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git", projectDisplayName: "app", projectRootPath: "/fixture" }] }),
    fetchAgent: async (id: string) => { const a = agents.find(a => a.id === id); return a ? { agent: a } : null; },
    fetchAgentTimeline: async (id: string) => { reads.push(id); return { entries: tail, startCursor: { epoch: "e", seq: tail[0].seqStart }, endCursor: { epoch: "e", seq: tail.at(-1)!.seqStart }, epoch: "e", hasOlder: false, error: null, gap: false, staleCursor: false, reset: false }; },
    listProviderSubagents: async () => ({ subagents: [] }),
  } as unknown as Daemon;
  const connect = (async work => work(client)) as typeof withDaemon;
  const gateway = new PaseoGateway(connect, new SessionGuard(dir), async () => false, new HistoryCache(null), () => clock);
  const store = new LinkedStore(dir);
  const svc = new LinkedService({ store, sources: fakeLinear({}).sources, now: () => NOW });
  const pending: Promise<unknown>[] = [];
  gateway.linkRefs = batch => { pending.push(svc.note(batch)); };
  const state: State = { version: 1, workspaces: [workspace({ id: "w-live", mainAgentId: "live" }), workspace({ id: "w-asleep", mainAgentId: "asleep" })] };

  await gateway.discover(state); await Promise.all(pending);
  assert.deepEqual(reads, ["live"], "only the loaded agent's timeline is read");
  let f = await store.read();
  assert.equal(f.workspaces["w-asleep"], undefined, "nothing extracted for the dormant workspace");
  assert.deepEqual(f.workspaces["w-live"].candidates.map(c => [c.key, c.seen, c.strong]), [["OPS-77", 1, false], ["ACME-1312", 1, true]]);

  // The next poll re-reads the same tail (the overlap) plus one new entry.
  tail = [...tail, said(3, "Done for now")];
  gateway.markDirty("live");
  await gateway.discover(state); await Promise.all(pending);
  assert.deepEqual(reads, ["live", "live"], "the second poll did read (incrementally)");
  f = await store.read();
  assert.deepEqual(f.workspaces["w-live"].candidates.map(c => [c.key, c.seen]), [["OPS-77", 1], ["ACME-1312", 1]], "the overlap isn't a second sighting");
  // A real second sighting does count.
  tail = [...tail, said(4, "OPS-77 again")];
  gateway.markDirty("live");
  await gateway.discover(state); await Promise.all(pending);
  assert.deepEqual((await store.read()).workspaces["w-live"].candidates.find(c => c.key === "OPS-77")?.seen, 2);
});
