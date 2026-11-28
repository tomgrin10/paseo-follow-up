// Report a bug straight from the workspace panel (AGENTS.md invariant 154, `a-workspace-report-files-only-structure`).
// 2026-11-28, the developer: "add an option to report a bug straight from the follow up panel ... that will also attach
// the agent data if needed from that workspace". The panel's ⋯ (the shared row menu) gets Report a bug about this
// workspace…, which opens the one Report sheet already about that workspace. The agent that files it reads the
// workspace locally; the public issue gets only structural rows, never the workspace's own words.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { createElement as ce } from "react";
import { fakeGithub } from "../scripts/fake-github.mjs";
import { httpApi } from "../server/github-api";
import { Reporter } from "../server/report-issue";
import { LogRing } from "../server/report-issue/diagnostics";
import { followUpReportConfig, reportPrompt, type FollowUpReportDeps } from "../server/report-issue-adapter";
import { sendReport, type ReportSendDeps } from "../server/report-send";
import { ROW_ACTIONS, rowMenu } from "../shared/row-menu";
import { NEW_AGENT, defaultChoice, reportAbout } from "../shared/report-send";
import { AGENT_TOOLS } from "../server/agent-actions";
import { PARITY } from "../server/agent-parity";
import { actionTools } from "../server/mcp.mjs";
import type { Workstream } from "../shared/home";
import type { State, Workspace } from "../shared/model";
import { pr, snapshot, workspace } from "./fixtures";

const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));
register("./support/native/hooks.mjs", import.meta.url);
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: { type: unknown; props: Record<string, unknown> }) => boolean): { props: Record<string, any>; type: unknown }[] }; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useRowMenu } = await import("../client/row-actions");
const { ReportSheet, reportRequestNow } = await import("../client/report-issue");
const client = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: any }[]; rpc: { reply: (name: string, input: unknown) => unknown } };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;

// Work-looking text a real workspace would hold. None of it may reach the public body.
const WS = "ws-acme-cutover";
const SECRET_TEXT = {
  title: "Migrate Acme invoices to Stripe Connect",
  goal: "Cut over acme-billing before the Q4 freeze",
  repo: "acme/billing-core",
  branch: "alice/acme-invoice-cutover",
  prTitle: "Acme invoice cutover: dual-write ledger",
  task: "Ask alice for the prod ledger credentials",
  taskEvidence: "alice said the ledger creds live in the acme vault",
  questionTitle: "Drop the legacy acme_invoices table?",
  question: "Should we drop the legacy acme_invoices table in prod before the freeze?",
  background: "Finance still reads acme_invoices on Fridays.",
  done: "Dual-write shipped for the Acme ledger",
};

function seeded(): Workspace {
  return workspace({
    id: WS, title: SECRET_TEXT.title, goal: SECRET_TEXT.goal, mainAgentId: "agent-main", repo: SECRET_TEXT.repo,
    prs: [
      pr({ key: `${SECRET_TEXT.repo}#41`, repo: SECRET_TEXT.repo, number: 41, stack: SECRET_TEXT.branch, snapshot: snapshot({ title: SECRET_TEXT.prTitle, headBranch: SECRET_TEXT.branch, state: "OPEN", failedChecks: ["ci / ledger-tests"], conflict: true }) }),
      pr({ key: `${SECRET_TEXT.repo}#40`, repo: SECRET_TEXT.repo, number: 40, stack: SECRET_TEXT.branch, snapshot: snapshot({ title: "Acme ledger schema", state: "MERGED" }) }),
    ],
    obligations: [{ id: "T1", title: SECRET_TEXT.task, status: "blocked", afterPrs: [], evidence: SECRET_TEXT.taskEvidence } as never],
    questions: [{ id: "Q1", title: SECRET_TEXT.questionTitle, question: SECRET_TEXT.question, background: SECRET_TEXT.background, big: null, options: [], recommend: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "agent-main", askedAt: "2026-11-28T08:00:00Z", mode: "decision", answer: null, closed: null } as never],
  });
}

async function reporterFor(w: Workspace, logs = new LogRing()) {
  const dir = await mkdtemp(join(tmpdir(), "report-panel-"));
  const fake = await fakeGithub({ dir, gh: "/bin/false", owners: ["tomgrin10"], handle: (r: { method: string; path: string }) => r.path.startsWith("search/issues") ? { status: 200, body: { items: [] } } : r.path === "user" ? { status: 200, body: { login: "reporter" } } : { status: 404, body: {} } });
  const api = httpApi({ base: fake.url, tokens: async () => "fixture-token-tomgrin10" });
  const deps: FollowUpReportDeps = {
    github: api, updates: async () => { throw new Error("none"); }, call: async () => null,
    snapshot: async () => ({ workspaces: [w] } as unknown as State), resources: () => ({ level: "ok" } as never), serverInfo: async () => null,
    logs, toolTransport: () => "native", startedAt: Date.parse("2026-11-28T07:00:00Z"), now: () => Date.parse("2026-11-28T09:00:00Z"),
    agents: async id => id === WS ? [{ id: "agent-main", title: "Acme cutover · main", provider: "claude", status: "idle" }, { id: "agent-2", title: "alice's ledger helper", provider: "codex", status: "running" }] : [],
  };
  const reporter = new Reporter(followUpReportConfig(deps));
  return { reporter, close: async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); } };
}

const fields = { title: "Send repairs stays queued", what_happened: "Send did nothing.", steps: ["Open the panel", "Click Send"], expected: "The batch goes out.", actual: "It stays queued." };

test("the public body holds no free text from the workspace, only structural rows", async () => {
  const logs = new LogRing();
  logs.push("warn", `[follow-up] refresh failed for ${WS} (${SECRET_TEXT.repo}#41): RATE_LIMIT while reading ${SECRET_TEXT.prTitle}`);
  const { reporter, close } = await reporterFor(seeded(), logs);
  try {
    const dry = await reporter.run("agent-x", { kind: "bug", fields, workspace_id: WS }) as { stage: string; body: string };
    assert.equal(dry.stage, "dry_run");
    for (const [what, value] of Object.entries(SECRET_TEXT)) assert.ok(!dry.body.includes(value), `${what} leaked into the issue: ${value}`);
    for (const piece of ["billing-core", "acme_invoices", "alice", "Stripe", WS, "Acme ledger schema", "ledger-tests"]) assert.ok(!dry.body.toLowerCase().includes(piece.toLowerCase()), `"${piece}" leaked into the issue`);
    assert.match(dry.body, /\*\*This workspace\*\*/);
    assert.match(dry.body, /\| PRs \| 2 \(1 open, 1 merged\)/);
    assert.match(dry.body, /\| Checks \(open PRs\) \| 1 failed/);
    assert.match(dry.body, /\| Conflicts \(open PRs\) \| 1 \|/);
    assert.match(dry.body, /\| Tasks \| 1 blocked \|/);
    assert.match(dry.body, /\| Questions \| 1 open · 0 answered · 0 closed \|/);
    assert.match(dry.body, /\| Agents \| 2 \(1 claude, 1 codex\) · main idle \|/);
    assert.match(dry.body, /\| Recent warnings about it \| 1 \(1 RATE_LIMIT\) \|/);
  } finally { await close(); }
});

test("the agent's own quote of the workspace's text is replaced before it reaches the issue", async () => {
  const { reporter, close } = await reporterFor(seeded());
  try {
    const dry = await reporter.run("agent-x", { kind: "bug", workspace_id: WS, fields: { ...fields, findings: `Q1 "${SECRET_TEXT.question}" blocks task "${SECRET_TEXT.task}" on ${SECRET_TEXT.title}.` } }) as { body: string; redacted: string };
    for (const value of [SECRET_TEXT.question, SECRET_TEXT.task, SECRET_TEXT.title]) assert.ok(!dry.body.includes(value), `quoted text leaked: ${value}`);
    assert.match(dry.redacted, /private PR title/);
  } finally { await close(); }
});

test("the reporting agent gets the workspace locally to diagnose, told it stays local", async () => {
  const { reporter, close } = await reporterFor(seeded());
  try {
    const first = await reporter.run("agent-x", { kind: "bug", summary: "Send stuck", workspace_id: WS }) as { subject: { id: string; local: any; issueGets: [string, string][]; note: string }; next: string };
    assert.equal(first.subject.id, WS);
    assert.equal(first.subject.local.title, SECRET_TEXT.title);
    assert.equal(first.subject.local.questions[0].question, SECRET_TEXT.question);
    assert.equal(first.subject.local.agents.length, 2);
    assert.match(first.subject.note, /stays on this machine/);
    assert.ok(first.subject.issueGets.some(([k]) => k === "Checks (open PRs)"));
    assert.match(first.next, /workspace_id="ws-acme-cutover"/);
    await assert.rejects(reporter.run("agent-x", { kind: "bug", summary: "x", workspace_id: "ws-nope" }), /knows nothing as workspace_id=ws-nope/);
  } finally { await close(); }
});

test("an idea or feedback carries no workspace section (only a bug needs it)", async () => {
  const { reporter, close } = await reporterFor(seeded());
  try {
    const dry = await reporter.run("agent-x", { kind: "feature", workspace_id: WS, fields: { title: "Group PRs", problem: "Many PRs.", proposal: "Group them." } }) as { body: string };
    assert.ok(!dry.body.includes("This workspace"));
  } finally { await close(); }
});

test("the row menu ends with Report a bug…, an agent tool (parity)", () => {
  const s = { key: `ws:${WS}`, agentId: "agent-main", workspaceId: WS, title: SECRET_TEXT.title, agent: null, word: null, line: "" } as unknown as Workstream;
  const sections = rowMenu({ s, flagged: false, snoozedUntil: null, w: seeded(), branch: SECRET_TEXT.branch, canAsk: false, archive: null } as never);
  const last = sections.at(-1)!;
  assert.equal(last.key, "report");
  assert.deepEqual(last.items.map(i => [i.action, i.label, i.icon]), [["report", "Report a bug…", "Bug"]]);
  assert.equal((ROW_ACTIONS.report as { tool: string }).tool, "report_issue");
  assert.ok((AGENT_TOOLS as readonly string[]).includes("report_issue"));
  const noWorkspace = rowMenu({ s: { ...s, workspaceId: null } as never, flagged: false, snoozedUntil: null, w: null, branch: null, canAsk: false, archive: null } as never);
  assert.ok(!noWorkspace.some(sec => sec.key === "report"), "no workspace, no item");
});

test("picking it opens the Report sheet about that workspace, as a bug", async () => {
  let menu: ReturnType<typeof useRowMenu> | null = null;
  const sources = { inbox: { rows: () => [], refresh() {} }, live: { get: () => seeded(), refresh() {} }, paseo: { get: () => undefined } } as never;
  function Probe() { menu = useRowMenu({ sources, overseerOn: false, openFull: () => {}, openQuestion: () => {} }); return null; }
  const qc = new QueryClient();
  await act(async () => { create(createElement(QueryClientProvider, { client: qc }, createElement(Probe, null))); });
  const s = { key: `ws:${WS}`, agentId: "agent-main", workspaceId: WS, title: SECRET_TEXT.title } as unknown as Workstream;
  await act(async () => { await menu!.pick(s, { key: "report", action: "report", label: "Report a bug…", icon: "Bug" }); });
  const req = reportRequestNow();
  assert.ok(req, "the sheet was asked for");
  assert.equal(req!.kind, "bug");
  assert.equal(req!.workspaceId, WS);
  assert.equal(req!.about, WS);
  assert.equal(req!.aboutTitle, SECRET_TEXT.title);
});

test("the sheet says what it's about, Send carries the workspace, and × sends it without", async () => {
  const targets = { agents: [{ id: "agent-main", title: "Acme cutover · main", provider: "claude", status: "idle", workspaceId: WS, workspaceTitle: SECRET_TEXT.title, main: true }], defaultId: "agent-main", newAgentWorkspace: { id: WS, title: SECRET_TEXT.title }, newWorkspace: null };
  client.rpc.reply = name => name === "follow.report-issue-targets" ? targets : { agentId: "agent-main", title: "Acme cutover · main", started: false, queued: true };
  const layout = { compact: true } as never;
  const sendAndRead = async (remove: boolean) => {
    client.rpcCalls.length = 0;
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(createElement(ReportSheet, { request: { kind: "bug", workspaceId: WS, about: WS, aboutTitle: SECRET_TEXT.title }, theme, layout, onClose: () => {} })); });
    const texts = () => r.root.findAll(n => typeof n.props.children === "string" || Array.isArray(n.props.children)).map(n => [n.props.children].flat().join(""));
    assert.ok(texts().some(t => t === `About ${SECRET_TEXT.title}`), "the About line names the workspace");
    if (remove) {
      await act(async () => { r.root.findAll(n => n.props.accessibilityLabel === `Don't include ${SECRET_TEXT.title}` && typeof n.props.onPress === "function")[0].props.onPress(); });
      assert.ok(!texts().some(t => t.startsWith("About ")), "× removes the About line");
      assert.ok(texts().some(t => t === `Include ${SECRET_TEXT.title}`), "and leaves a way to include it again");
    }
    await act(async () => { r.root.findAll(n => n.props.accessibilityLabel === "Describe it" && typeof n.props.onChangeText === "function")[0].props.onChangeText("Send did nothing"); });
    await act(async () => { r.root.findAll(n => (n.props.title === "Send to agent" || n.props.title === "Start agent and send") && typeof n.props.onPress === "function")[0].props.onPress(); });
    r.unmount();
    return client.rpcCalls.find(c => c.name === "follow.report-issue-send")!.input;
  };
  const about = await sendAndRead(false);
  assert.equal(about.workspaceId, WS);
  assert.equal(about.newAgentWorkspaceId, WS, "a new agent in that workspace, not its main agent");
  const plain = await sendAndRead(true);
  assert.equal(plain.workspaceId, undefined);
  assert.equal(plain.agentId, "agent-main", "without the workspace, today's default");
});

test("a report about a workspace starts a new agent there by default, never pulling in its busy main agent", () => {
  const t = { agents: [{ id: "agent-main" }], defaultId: "agent-main", newAgentWorkspace: { id: WS, title: "x" }, newWorkspace: null } as never;
  assert.equal(defaultChoice(t, WS), NEW_AGENT);
  assert.equal(defaultChoice(t, null), "agent-main", "without one, today's default");
  assert.equal(defaultChoice({ ...(t as object), newAgentWorkspace: { id: "other", title: "y" } } as never, WS), "agent-main");
});

test("the About line applies to a bug only, until removed", () => {
  assert.equal(reportAbout({ about: WS }, "bug", false), WS);
  assert.equal(reportAbout({ about: WS }, "feature", false), null);
  assert.equal(reportAbout({ about: WS }, "feedback", false), null);
  assert.equal(reportAbout({ about: WS }, "bug", true), null);
  assert.equal(reportAbout({}, "bug", false), null);
});

test("the prompt and report_send carry the workspace id, never its title", async () => {
  const p = reportPrompt("bug", "Send stuck", null, WS);
  assert.match(p, /workspace_id="ws-acme-cutover"/);
  assert.ok(!p.includes(SECRET_TEXT.title));
  assert.ok(!reportPrompt("bug", "x").includes("workspace_id"));
  const sent: string[] = [];
  const deps = { sendTo: async (_a: string, prompt: string) => { sent.push(prompt); }, agentTitle: async () => "main", rows: async () => null, multiplicity: async () => true, provider: async () => ({}), paseo: {} } as unknown as ReportSendDeps;
  await sendReport(deps, { kind: "bug", text: "Send stuck", agentId: "agent-main", workspaceId: WS });
  assert.match(sent[0], /workspace_id="ws-acme-cutover"/);
  const tool = (actionTools as unknown as [string, string, string, Record<string, unknown>][]).find(t => t[0] === "report_send")!;
  assert.ok("workspaceId" in tool[3]);
  assert.ok("workspace_id" in (actionTools as unknown as [string, string, string, Record<string, unknown>][]).find(t => t[0] === "report_issue")![3]);
  assert.ok(PARITY["follow.report-issue-send"]);
});
