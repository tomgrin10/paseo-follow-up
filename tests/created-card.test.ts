import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cardFollow, cardMeta, cardPresence, cardTitle, createdCard, createdCardSchema, createdKind, type CreatedLive } from "../shared/created";
import { PRESENCE, workingLine } from "../shared/task-status";
import { createdItems, followLine } from "../server/created-items";
import type { DirectoryRows } from "../server/directory";
import type { Obligation } from "../shared/model";
import { workspace, pr, snapshot } from "./fixtures";

/** The chat card for agents and workspaces an agent creates (task 0f71fa9f, Q35=B). */

// A real create_agent result's shape (ids and names fictional).
const agentResult = JSON.stringify({ agentId: "agent-new", type: "claude", status: "running", cwd: "/work", workspaceId: "wks_pill", currentModeId: "bypassPermissions", guidance: "Creation acknowledged.", serverId: "srv_1" });
const call = (name: string, status: "running" | "completed" | "failed" | "canceled", input: Record<string, unknown>, output?: unknown, error: unknown = null) =>
  ({ type: "tool_call" as const, callId: "c1", name, status, error, detail: { type: "unknown", input, ...(output === undefined ? {} : { output }) } });

test("create calls are recognised by name across providers, and nothing else is", () => {
  assert.equal(createdKind("mcp__paseo__create_agent"), "agent");
  assert.equal(createdKind("paseo.create_workspace"), "workspace");
  assert.equal(createdKind("paseo/create_agent"), "agent");
  assert.equal(createdKind("mcp__paseo__create_schedule"), null);
  assert.equal(createdKind("mcp__paseo__follow_update_obligation"), null);
});

test("a completed create_agent becomes a card with its id, workspace, model and provider", () => {
  const card = createdCard(call("mcp__paseo__create_agent", "completed", { title: "Reader fix", provider: "claude/claude-opus-5-5" }, agentResult))!;
  assert.deepEqual(createdCardSchema.parse(card), card);
  assert.equal(card.phase, "created"); assert.equal(card.id, "agent-new"); assert.equal(card.workspaceId, "wks_pill");
  assert.equal(card.model, "Opus 5.5"); assert.equal(card.provider, "claude"); assert.equal(card.title, "Reader fix");
  // MCP content blocks parse the same.
  assert.equal(createdCard(call("mcp__paseo__create_agent", "completed", {}, { content: [{ type: "text", text: agentResult }] }))?.id, "agent-new");
});

test("feature detection per call: no id in the result, or a canceled call, keeps Paseo's plain row", () => {
  assert.equal(createdCard(call("mcp__paseo__create_agent", "completed", { title: "x" }, "Created.")), null);
  assert.equal(createdCard(call("mcp__paseo__create_agent", "completed", { title: "x" }, JSON.stringify({ ok: true }))), null);
  assert.equal(createdCard(call("mcp__paseo__create_agent", "canceled", { title: "x" })), null);
  assert.equal(createdCard(call("mcp__paseo__list_agents", "completed", {}, agentResult)), null);
});

test("starting and failed cards: words only, never a link, the error in full for the accessibility label", () => {
  const starting = createdCard(call("mcp__paseo__create_agent", "running", { title: "Search index rebuild", provider: "claude/claude-sonnet-5-5" }))!;
  assert.equal(cardTitle(starting, undefined), "Starting Search index rebuild…");
  assert.equal(cardPresence(starting, undefined).opens, false);
  const failed = createdCard(call("mcp__paseo__create_agent", "failed", { title: "Search index rebuild" }, undefined, { message: "Provider claude/claude-sonnet-5-5 is not available on this host" }))!;
  assert.equal(cardTitle(failed, undefined), "Couldn't start Search index rebuild");
  assert.equal(cardMeta(failed, undefined), "Provider claude/claude-sonnet-5-5 is not available on this host");
  assert.equal(cardPresence(failed, undefined).opens, false);
  // An MCP error result (isError) fails too.
  assert.equal(createdCard(call("mcp__paseo__create_agent", "completed", { title: "x" }, { isError: true, content: [{ type: "text", text: "Workspace not found" }] }))?.error, "Workspace not found");
  const creating = createdCard(call("mcp__paseo__create_workspace", "running", { title: "billing-retry", isolation: "worktree", path: "/src/billing" }))!;
  assert.equal(cardTitle(creating, undefined), "Creating billing-retry…");
});

test("a created workspace card opens the workspace and names its branch and repository", () => {
  const card = createdCard(call("mcp__paseo__create_workspace", "completed", { isolation: "worktree", branchName: "feat/billing-retry", path: "/src/billing" }, JSON.stringify({ workspace: { id: "wks_billing", name: "billing-retry" } })))!;
  assert.equal(card.id, "wks_billing"); assert.equal(card.title, "feat/billing-retry");
  assert.equal(cardMeta(card, undefined), "New workspace · feat/billing-retry · billing");
  assert.equal(cardPresence(card, undefined).opens, true);
  assert.equal(cardTitle(card, { agents: {}, workspaces: { wks_billing: { name: "billing-retry", follow: null } } }), "billing-retry");
});

test("one presence table: the card's words and links match the task line's for every state", () => {
  const card = createdCard(call("mcp__paseo__create_agent", "completed", { title: "Reader fix" }, agentResult))!;
  const o = { id: "t", title: "Fix", status: "working", afterPrs: [], evidence: "", enable_follow_up: false, revision: 0, workingAgentId: "agent-new" } as Obligation;
  for (const state of ["working", "idle", "closed", "archived"] as const) {
    const live: CreatedLive = { agents: { "agent-new": { title: "Reader fix", state, workspaceId: "wks_pill", main: false } }, workspaces: { wks_pill: { name: "Pill cleanup", follow: null } } };
    const p = cardPresence(card, live);
    const line = workingLine(o, { "agent-new": { title: "Reader fix", state } });
    assert.equal(p.word.toLowerCase(), PRESENCE[state].word);
    assert.equal(line.text, `Reader fix ${PRESENCE[state].word}`);
    assert.equal(p.opens, !!line.agentId, `${state}: the card opens exactly when the task line links`);
    assert.equal(p.link, state === "closed" ? line.link : null, `${state}: a closed agent says "Open chat" on both`);
    assert.equal(cardMeta(card, live), "New agent · Pill cleanup");
  }
  // Closed (Paseo ended the session: idle unload, a plugin reload) keeps its link; the developer's tap is the only load.
  assert.deepEqual(PRESENCE.closed, { word: "closed", opens: true, link: "Open chat" });
  assert.deepEqual(PRESENCE.archived, { word: "archived", opens: false, link: null }, "archived: words only");
  assert.equal(cardPresence(card, { agents: {}, workspaces: {} }).opens, false, "unknown agent: words only");
});

const rows = (agents: { id: string; status: string; title?: string; workspaceId?: string; archivedAt?: string | null }[]): DirectoryRows => ({
  agents: agents.map(a => ({ agent: { workspaceId: null, archivedAt: null, pendingPermissions: [], activeTurn: null, labels: {}, ...a } as never })),
  workspaces: [{ id: "wks_pill", name: "Pill cleanup" }, { id: "wks_billing", name: "billing-retry" }], projects: [],
});

test("created-items: live states from the directory snapshot, main-agent flag, and no state when it's unreadable", () => {
  const w = workspace({ id: "wks_billing", mainAgentId: "main-1", prs: [] });
  const live = createdItems({ agentIds: ["run-1", "idle-1", "gone", "main-1"], workspaceIds: [] },
    rows([{ id: "run-1", status: "running", title: "Reader fix", workspaceId: "wks_pill" }, { id: "idle-1", status: "idle", workspaceId: "wks_pill" }, { id: "main-1", status: "idle", workspaceId: "wks_billing" }]), [w]);
  assert.equal(live.agents["run-1"]!.state, "working");
  assert.equal(live.agents["idle-1"]!.state, "idle");
  assert.equal(live.agents.gone, undefined, "not listed: unknown, so the card is words only");
  assert.equal(live.agents["main-1"]!.main, true);
  assert.equal(live.agents["run-1"]!.main, false);
  assert.equal(live.workspaces.wks_pill!.name, "Pill cleanup");
  assert.deepEqual(createdItems({ agentIds: ["run-1"], workspaceIds: ["wks_pill"] }, null, [w]), { agents: {}, workspaces: {} });
});

test("the Follow-up line says something only when there is something: a question, PR chips, or the live line", () => {
  const quiet = workspace({ id: "wks_billing", prs: [] });
  assert.equal(followLine(quiet), null);
  const asking = workspace({ id: "wks_billing", questions: [{ id: "Q2", title: "Pick a rollout window" } as never] });
  const q = followLine({ ...asking, questions: asking.questions.map(x => ({ ...x, answer: null, closed: null })) as never });
  assert.deepEqual(q?.question, { id: "Q2", title: "Pick a rollout window" });
  const merged = followLine(workspace({ id: "wks_billing", prs: [pr({ number: 88, snapshot: snapshot({ state: "MERGED" }) })] }));
  assert.equal(merged?.chips[0]?.tone, "merged");
  assert.match(merged?.chips[0]?.text ?? "", /^#88 /);
  // A subagent's card never borrows its workspace's line; the main agent's and a workspace card's do.
  const live: CreatedLive = { agents: { sub: { title: "x", state: "idle", workspaceId: "wks_billing", main: false }, main: { title: "y", state: "idle", workspaceId: "wks_billing", main: true } },
    workspaces: { wks_billing: { name: "billing-retry", follow: merged } } };
  const agentCard = (id: string) => createdCard(call("mcp__paseo__create_agent", "completed", {}, JSON.stringify({ agentId: id, workspaceId: "wks_billing" })))!;
  assert.equal(cardFollow(agentCard("sub"), live), null);
  assert.equal(cardFollow(agentCard("main"), live), merged);
});

test("the card is feature-detected, polls only while visible and open, and reads the cached directory", async () => {
  const root = join(import.meta.dirname, "..");
  const client = await readFile(join(root, "client/created.tsx"), "utf8");
  assert.match(client, /typeof api\.addTimelineTransformer === "function" && typeof api\.addTimelineRenderer === "function"/);
  assert.match(client, /if \(!timelineSupported\(client\)\) return/);
  const chat = await readFile(join(root, "client/chat.tsx"), "utf8");
  assert.match(chat, /if \(!timelineSupported\(client\)\) return/, "the chat transforms are feature-detected too");
  // The host refuses a renderer kind outside [a-z0-9-] ("Invalid timeline renderer kind"), and that one throw stops
  // Follow-up's whole client from loading. Every kind is a plain slug.
  const kinds = [...(chat + client + await readFile(join(root, "shared/created.ts"), "utf8") + await readFile(join(root, "shared/brief.ts"), "utf8")).matchAll(/_KIND = "([^"]+)"/g)].map(m => m[1]);
  assert.ok(kinds.length >= 4);
  for (const kind of kinds) assert.match(kind!, /^[a-z][a-z0-9-]*$/, `timeline kind "${kind}"`);
  assert.match(client, /!== "archived" && appVisible\(\) \? CREATED_POLL_MS : false/);
  assert.match(client, /<Spinner /, "starting uses Follow-up's spinner");
  // Rendering a card or a task row never loads an agent on its own: no Paseo API, timeline or agent fetch in either
  // component; the only load is the developer's tap (navigation).
  const tasks = await readFile(join(root, "client/tasks.tsx"), "utf8");
  for (const [file, src] of [["client/created.tsx", client], ["client/tasks.tsx", tasks]] as const)
    assert.doesNotMatch(src, /fetchAgent|timeline\.|agents\.ref|\.paseo\b|usePaseo/, `${file} must not read agents itself`);
  const server = await readFile(join(root, "index.server.ts"), "utf8");
  const handler = server.split("\n").find(l => l.includes("handle(rpc.createdItemsRpc"))!;
  assert.match(handler, /gateway\.directory\.snapshot\(\)/, "the engine's snapshot as it stands");
  assert.doesNotMatch(handler, /\.read\(|fresh/, "never waits on or asks the daemon");
});
