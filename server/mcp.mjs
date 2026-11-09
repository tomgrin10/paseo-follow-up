#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";

const string = { type: "string" };
const boolean = { type: "boolean" };
const integer = { type: "integer", minimum: 1 };
const array = { type: "array", items: string };
const communication = { type: "object", properties: { threadUrl: string, recipient: string, purpose: { type: "string", enum: ["progress", "verified"] }, authorization: string, replyUrl: { type: ["string", "null"] } }, required: ["threadUrl", "recipient"], additionalProperties: false };
const trigger = { type: ["object", "null"], properties: { event: { type: "string", enum: ["now", "merge", "deploy"] }, delayDays: { type: "integer", minimum: 0, maximum: 3650 } }, required: ["event"], additionalProperties: false };
const tools = [
  ["workspace_status", "Read the tracked workspace's durable goal, PRs, tasks, work queue and optional recovery history. Read after compaction. Returns current work by default; detail=full includes complete evidence/history. Normal follow-through does not require recovery.", "follow.agent-status", { detail: { type: "string", enum: ["summary", "full"] } }, []],
  ["sync_workspace", "Silently confirm the sidebar matches your work before finishing, after registering owned PRs and substantive tasks. Call even when no changes are needed. Keep the summary in this tool; never announce sync or recap sidebar/plugin status to the developer. Does not declare Done, run recovery, or start repairs. Tracked root agents only.", "follow.sync", { summary: { ...string, minLength: 1, maxLength: 1000 } }, ["summary"]],
  ["enroll_workspace", "Refine this developer-activated workspace's goal. Ownership is initialized by Track this workspace or the project’s default-tracking setting. This tool cannot activate another workspace. Never ask the developer to enter this. Keep the goal concise; new scope reopens completion.", "follow.enroll", { goal: string }, ["goal"]],
  ["register_pr", "Register a PR produced by this workspace. Call after every submission. Register parents first; repeat to update its stack or parent after restacking. Supply a disposition for a deliberately closed PR.", "follow.register-pr", { repo: string, number: integer, stack: string, parentNumber: { type: ["integer", "null"], minimum: 1 }, disposition: string }, ["repo", "number", "stack"]],
  ["exclude_stack", "Correct an unrelated stack registration. Preserve its PRs and requirements in an exclusion audit; future registration is blocked. reason must cite the scope/ownership evidence. obligationIds may include related tasks without PR dependencies. Keep external dependencies separate from owned work.", "follow.exclude-stack", { stack: string, reason: string, obligationIds: array }, ["stack", "reason"]],
  ["update_obligation", "Record concrete follow-through: verification, migrations, decisions or stakeholder replies. Never add approve/merge/deploy checklist tasks. afterPrs uses owner/repo#number keys. Tasks are manual unless explicitly scheduled with trigger={event:\"now\"|\"merge\"|\"deploy\",delayDays:0}. Only set a trigger from the developer’s requested timing; never infer timing from a title or enable_follow_up alone. Merge/deploy triggers require owned afterPrs; delayDays=14 waits fourteen days after the last dependency event. Now requires no PR dependencies or delay. Deployment timing starts at the first verified fully serving observation and remains conservative when history is unknown. Preserve existing trigger fields on updates; trigger=null makes a task manual. Auto controls delivery, not timing or production permissions. For Slack replies, communication records the original threadUrl, recipient, purpose (progress or verified), explicit developer authorization and sent replyUrl. Empty authorization never queues a reply; Auto does not authorize external posts. Use a verify-and-reply task after deployment for the final update. Read the thread first; mark blocked when posting is unavailable or uncertain, never treat a draft as sent. Done requires replyUrl and evidence; preserve fields when updating.", "follow.obligation", { id: string, title: string, status: { type: "string", enum: ["pending", "waiting", "working", "blocked", "done", "waived"] }, afterPrs: array, dependencyStage: { type: "string", enum: ["merged", "deployed"] }, evidence: string, enable_follow_up: boolean, communication, trigger }, ["title", "status"]],
  ["acknowledge_batch", "Record a follow-up result. Complete only after verifying all tasks; blocked surfaces the reason to the developer. Always acknowledge before ending a repair turn. Keep the result within 2000 characters.", "follow.acknowledge", { batchId: string, outcome: { type: "string", enum: ["completed", "blocked"] }, result: { ...string, maxLength: 2000 } }, ["batchId", "outcome", "result"]],
  ["ask_question", "Ask the developer a decision you can't make yourself. Give a short title, the question, lettered options A, B, C… with what each means for them, and recommend the option you'd pick. Set big only when building ahead would send something off this computer, set something people or programs outside the repo rely on, or most remaining work would build on it. Link a PR (owner/repo#number) or task id when it is about one. The reply says the question mode and exactly what to do until the answer arrives.", "follow.ask-question", { title: { ...string, maxLength: 120 }, question: { ...string, maxLength: 2000 }, options: { type: "array", maxItems: 26, items: { type: "object", properties: { letter: { type: "string", pattern: "^[A-Z]$" }, label: { ...string, maxLength: 200 }, consequence: { ...string, maxLength: 600 } }, required: ["letter", "label"], additionalProperties: false } }, recommend: string, big: string, background: string, links: { type: "array", maxItems: 10, items: { type: "object", properties: { url: string, path: string, label: string }, additionalProperties: false } }, pr: string, task: string }, ["title", "question"]],
  ["record_answer", "Record the developer's answer when they answered a question in chat instead of in Follow-up. choice is an option letter, or their short answer when there were no options; words is what they said.", "follow.record-answer", { id: string, choice: string, words: string }, ["id", "choice"]],
  ["withdraw_question", "Withdraw a question that no longer matters, with a short reason.", "follow.withdraw-question", { id: string, reason: string }, ["id", "reason"]],
  ["set_spec", "Register the link to this workspace's spec: the Claude artifact (or doc) you keep summarizing the goal, decisions and status. Call it once after the first publish, with the URL from the publish result, and again only if the link changes. Follow-up shows it in the workspace header.", "follow.set-spec", { url: { ...string, maxLength: 2000 }, title: { ...string, maxLength: 120 } }, ["url"]],
  ["needs_you", "Call once at the end of a turn, just before your final reply: what the developer has to do next. ask is one line (≤120). kind: decision (give decisions with 2–5 options, a consequence each and recommend=<option index>), action (something only they can do: merge, approve, log in, run or send), review (a PR to review and merge; link it with pr), or done (\"Nothing needed. <what you finished>.\": nothing for the developer, won't flag you). context ≤400 chars: only what they need to decide. Never blocks and never changes what you should do next.", "follow.needs-you", { ask: { ...string, minLength: 1, maxLength: 120 }, kind: { type: "string", enum: ["decision", "action", "review", "done"] }, decisions: { type: "array", maxItems: 3, items: { type: "object", properties: { question: { ...string, minLength: 1, maxLength: 200 }, options: { type: "array", minItems: 2, maxItems: 5, items: { type: "object", properties: { label: { ...string, minLength: 1, maxLength: 60 }, consequence: { ...string, maxLength: 160 } }, required: ["label"], additionalProperties: false } }, recommend: { type: "integer", minimum: 0, maximum: 4 } }, required: ["question"], additionalProperties: false } }, context: { ...string, maxLength: 400 }, links: { type: "array", maxItems: 4, items: { type: "object", properties: { label: string, url: string, path: string, pr: string }, required: ["label"], additionalProperties: false } } }, ["ask", "kind"]],
  ["declare_done", "Declare that the workspace goal is fulfilled. Live PR status and remaining obligations are checked; returned blockers must be resolved first. Done labels the workspace but never archives it.", "follow.done", { summary: string }, ["summary"]],
];

// Agent parity: every action the developer can click in Follow-up, through the same server path (follow.agent-act).
// Planned tools return a dry run; confirm=true with its planId runs it. Use them only when the developer asked.
const planned = { planId: string, confirm: boolean };
const prKey = { ...string, description: "owner/repo#number, from list_prs" };
const ask = " Only when the developer asked for it. Returns a dry-run plan first; run it with confirm=true and the planId.";
const actionTools = [
  ["list_prs", "List tracked PRs across all workspaces with state, draft, checks, open threads, requested reviewers and merge blockers. Filters: needs_reviewers, ready_to_merge, workspace (id or title). This is how you act \"on all\".", "follow.agent-act", { workspace: string, needs_reviewers: boolean, ready_to_merge: boolean, include_closed: boolean }, []],
  ["add_reviewers", "Request reviewers on one or many PRs, the same as the Add reviewers button. Without reviewers, uses the repository's default reviewers; otherwise the GitHub logins you give." + ask, "follow.agent-act", { prs: { type: "array", items: prKey }, reviewers: array, ...planned }, []],
  ["merge", "Merge a PR (and its downstack with scope=downstack) through Graphite, using Follow-up's merge plan and blockers. Can't be undone." + ask, "follow.agent-act", { pr: prKey, scope: { type: "string", enum: ["target", "downstack"] }, ...planned }, []],
  ["enable_merge_when_ready", "Turn on Graphite merge-when-ready for a PR, as the PR sheet does." + ask, "follow.agent-act", { pr: prKey, scope: { type: "string", enum: ["target", "downstack"] }, ...planned }, []],
  ["disable_merge_when_ready", "Turn off Graphite merge-when-ready for a PR." + ask, "follow.agent-act", { pr: prKey, scope: { type: "string", enum: ["target", "downstack"] }, ...planned }, []],
  ["send_repairs", "Send a workspace's waiting repairs (review threads, failed checks) to its main agent, like the Send button. Only when the developer asked. batchId defaults to the waiting batch.", "follow.agent-act", { workspace: string, batchId: string }, ["workspace"]],
  ["set_auto_send", "Turn Auto-send on or off for a workspace, like its switch. Only when the developer asked.", "follow.agent-act", { workspace: string, value: boolean }, ["workspace", "value"]],
  ["clear_hold", "Resume Follow-up on a held workspace, like the Resume button. Only when the developer asked.", "follow.agent-act", { workspace: string }, ["workspace"]],
  ["retry_batch", "Queue a blocked or uncertain repair batch again, like the Retry button. Only when the developer asked.", "follow.agent-act", { workspace: string, batchId: string }, ["workspace", "batchId"]],
  ["track", "Follow a workspace again after the developer opted it out in Settings. Follow-up follows every workspace by default. Only when the developer asked.", "follow.agent-act", { workspace: string }, ["workspace"]],
  ["inbox_list", "Read the developer's Needs-you inbox: each root agent, whether it is flagged and why, snoozes and finish flags. Your own row has self=true.", "follow.agent-act", { flagged_only: boolean }, []],
  ["sign_off", "Sign off other agents' Needs-you flags on the developer's behalf, like Sign off. Never your own." + ask, "follow.agent-act", { agentIds: array, ...planned }, []],
  ["snooze", "Snooze other agents' flags (until: next-event, 1h, tomorrow or an ISO time), like Later." + ask, "follow.agent-act", { agentIds: array, until: string, ...planned }, []],
  ["set_finish_flags", "Turn finish flags on or off for other agents, like Don't flag finishes." + ask, "follow.agent-act", { agentIds: array, value: boolean, ...planned }, []],
  ["set_priorities", "Rank workspaces for Home's Priority sort: per workspace (id or exact title) a score 0-100, a one-line reason the developer sees, and its sources [{kind: linear|slack|planning|github|paseo, label, url}]. replace=true drops workspaces you leave out. Used for 6 hours. Returns a dry run; store it with confirm=true and the planId.", "follow.agent-act", { priorities: { type: "array", items: { type: "object", properties: { workspace: string, score: { type: "integer", minimum: 0, maximum: 100 }, reason: { ...string, maxLength: 140 }, sources: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["linear", "slack", "planning", "github", "paseo"] }, label: string, url: string }, required: ["kind", "label"] } } }, required: ["workspace", "score", "reason"] } }, replace: boolean, ...planned }, ["priorities"]],
];
const actionNames = new Set(actionTools.map(t => t[0]));
const readOnlyTools = new Set(["workspace_status", "list_prs", "inbox_list"]);
const destructiveTools = new Set(["merge"]);
const actionInstruction = "Follow-up's action tools let you do what the developer can click, across every tracked workspace: list_prs and inbox_list to read; add_reviewers, merge, enable/disable_merge_when_ready, send_repairs, set_auto_send, clear_hold, retry_batch, track, set_priorities, and sign_off/snooze/set_finish_flags for other agents. Use them only when the developer asks (\"the PRs look good, assign reviewers on all\": list_prs needs_reviewers=true, add_reviewers with those keys, then confirm the plan). Planned tools return a dry run; run it with confirm=true and its planId. Never sign yourself off.";

// The brief's tool: every root agent while the Needs-you inbox is on; never contributors, recovery or subagents.
// Kept identical to NEEDS_YOU_INSTRUCTION in shared/brief.ts (a test checks it).
const needsYouInstruction = "When you end a turn, call `needs_you` once, just before your final reply, with what the developer has to do next: a decision (give 2–3 options, what each means for them, and the one you recommend), an action only they can take (merge, approve, log in, run or send something), or kind=done (\"Nothing needed\" plus what you finished, in one line), which means there is nothing for the developer and won't flag you in their inbox. Keep `ask` to one line and `context` to what they need to decide. Don't repeat your report there; still write your normal reply. Don't call it while a permission prompt is waiting or while you're still working.";
function toolList(recovery = process.env.FOLLOW_THROUGH_RECOVERY === "1", contributor = false, brief = false, briefOnly = false, actions = false) {
  // Action tools: root agents (tracked main or untracked) while Follow-up runs; never recovery or contributors.
  const acting = actions && !recovery && !contributor ? actionTools : [];
  if (briefOnly) return [...(brief ? tools.filter(t => t[0] === "needs_you") : []), ...acting];
  return [...tools.filter(t => t[0] === "needs_you" ? brief && !recovery && !contributor : contributor ? ["workspace_status", "register_pr", "sync_workspace"].includes(t[0]) : !recovery || !["declare_done", "sync_workspace", "ask_question", "record_answer", "withdraw_question", "set_spec"].includes(t[0])), ...acting];
}
/** Whether this session may call needs_you: launched as a root agent (FOLLOW_THROUGH_BRIEF) and the inbox is on. */
async function briefEnabled() {
  if (!process.env.FOLLOW_THROUGH_BRIEF || process.env.FOLLOW_THROUGH_RECOVERY === "1") return false;
  try {
    const directory = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data/follow-through");
    const lease = JSON.parse(await readFile(join(directory, "hooks-enabled.json"), "utf8"));
    if (!(lease.expiresAt > Date.now())) return false;
    const brief = JSON.parse(await readFile(join(directory, "brief.json"), "utf8"));
    return brief?.enable_inbox === true;
  } catch { return false; }
}
const schemas = list => list.map(([name, description, , properties, required]) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnlyTools.has(name), destructiveHint: destructiveTools.has(name) } }));
/** Action tools: a session Paseo launched as a root agent (FOLLOW_THROUGH_ROOT) while Follow-up runs (fresh hook lease). */
async function actionsEnabled() {
  if (!process.env.PASEO_AGENT_ID || process.env.FOLLOW_THROUGH_ROOT !== "1" || process.env.FOLLOW_THROUGH_RECOVERY === "1") return false;
  try {
    const lease = JSON.parse(await readFile(join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data/follow-through/hooks-enabled.json"), "utf8"));
    return lease.expiresAt > Date.now();
  } catch { return false; }
}
/** The bridge input for a tool: action tools travel as { tool, args } through follow.agent-act. */
const callInput = (tool, input) => actionNames.has(tool[0]) ? { tool: tool[0], args: input } : input;
let scopeCache = null;
async function scopeOf(directory, agentId) {
  try {
    const path = join(directory, "scopes.json");
    const { mtimeMs } = await stat(path);
    if (scopeCache?.mtimeMs !== mtimeMs) scopeCache = { mtimeMs, agents: JSON.parse(await readFile(path, "utf8")).agents ?? {} };
    return scopeCache.agents[agentId]?.role ?? null;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    for (const w of state.workspaces) {
      if (!w.enable_tracking || w.archived) continue;
      if (w.mainAgentId === agentId) return "main";
      if (w.batches.some(b => b.recipientAgentId === agentId && !b.settledAt && ["sending", "sent", "blocked", "uncertain"].includes(b.state) && b.tasks.every(t => t.kind === "inventory"))) return "recovery";
      if (w.contributorAgentIds?.includes(agentId)) return "contributor";
    }
    return null;
  }
}
async function scope(resolveRecovery = false) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) return null;
  try {
    const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
    const directory = join(home, "plugin-data/follow-through");
    const lease = JSON.parse(await readFile(join(directory, "hooks-enabled.json"), "utf8"));
    if (!(lease.expiresAt > Date.now())) return null;
    // scopes.json (a few KB, rewritten only when a role changes) instead of the whole state.json; re-read only
    // when its mtime changes. Older workers don't write it, so fall back to state.json.
    const known = await scopeOf(directory, agentId);
    if (known === "main") return process.env.FOLLOW_THROUGH_RECOVERY === "1" ? "recovery" : "main";
    if (known) return known;
    if (resolveRecovery && process.env.FOLLOW_THROUGH_RECOVERY === "1") {
      const w = await call("follow.agent-status", {});
      if (w.enable_tracking && !w.archived && w.mainAgentId !== agentId && w.batches.some(b => b.recipientAgentId === agentId && !b.settledAt && ["sending", "sent", "blocked", "uncertain"].includes(b.state) && b.tasks.every(t => t.kind === "inventory"))) return "recovery";
    }
  } catch {}
  return null;
}
function validate(value, schema, path = "arguments") {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(type) && !(type === "number" && types.includes("integer") && Number.isInteger(value))) throw new Error(`${path}: expected ${types.join(" or ")}.`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: choose ${schema.enum.join(", ")}.`);
  if (type === "object") {
    const extra = Object.keys(value).filter(k => !Object.hasOwn(schema.properties ?? {}, k));
    if (extra.length && schema.additionalProperties === false) throw new Error(`Unknown argument ${path}.${extra.join(", ")}. ${extra.includes("dependsOnPrs") ? "Use afterPrs with owner/repo#number keys." : "Check this tool's input schema with list."}`);
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required. Check this tool's input schema with list.`);
    for (const [key, nested] of Object.entries(value)) if (schema.properties?.[key]) validate(nested, schema.properties[key], `${path}.${key}`);
  }
  if (type === "array") for (let i = 0; i < value.length; i++) validate(value[i], schema.items, `${path}[${i}]`);
  if (type === "number" && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${path}: outside the allowed range.`);
  if (type === "string" && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength)) throw new Error(`${path}: outside the allowed length.`);
}
function currentWork(w) {
  return { id: w.id, title: w.title, goal: w.goal, mainAgentId: w.mainAgentId, enable_tracking: w.enable_tracking, enable_auto_sends: w.enable_auto_sends, hold: w.hold, archived: w.archived, runtimeBusy: w.runtimeBusy, runtimeReason: w.runtimeReason, backgroundBusy: w.backgroundBusy, completion: w.completion,
    prs: w.prs.map(p => ({ key: p.key, stack: p.stack, parent: p.parent, disposition: p.disposition, error: p.error, ...(p.snapshot ? { title: p.snapshot.title, state: p.snapshot.state, head: p.snapshot.head, draft: p.snapshot.draft, reviewDecision: p.snapshot.reviewDecision, conflict: p.snapshot.conflict, openThreads: p.snapshot.threads.length, failedChecks: p.snapshot.failedChecks, otherFailedChecks: p.snapshot.otherFailedChecks ?? [], deployment: p.snapshot.deployment } : {}) })),
    obligations: w.obligations.filter(o => !["done", "waived"].includes(o.status)), completedObligations: w.obligations.filter(o => ["done", "waived"].includes(o.status)).length,
    openQuestions: (w.questions ?? []).filter(q => !q.answer && !q.closed).map(q => ({ id: q.id, title: q.title, question: q.question, options: q.options, recommend: q.recommend, big: q.big, mode: q.mode, askedBy: q.askedBy, taskId: q.taskId })),
    spec: w.spec?.url ? { url: w.spec.url, title: w.spec.title, source: w.spec.source } : null,
    recentAnswers: (w.questions ?? []).filter(q => q.answer).slice(-5).map(q => ({ id: q.id, title: q.title, choice: q.answer.choice, words: q.answer.words, delivery: q.answer.delivery.state })),
    batches: w.batches.filter(b => !["completed", "cancelled"].includes(b.state)).map(b => ({ id: b.id, state: b.state, tasks: b.tasks, result: b.result, recipientAgentId: b.recipientAgentId, contextPath: b.contextPath })),
    excludedStacks: w.excludedStacks.map(s => ({ name: s.name, reason: s.reason, prs: s.prs.map(p => p.key) })), detail: "summary" };
}
function compact(tool, input, result) {
  if (actionNames.has(tool)) return result;
  if (tool === "workspace_status") return currentWork(result);
  if (tool === "needs_you") return { ok: result.ok, briefId: result.briefId };
  if (tool === "declare_done") return { workspaceId: result.workspace.id, completion: result.workspace.completion, blockers: result.blockers };
  if (tool === "ask_question") return { workspaceId: result.workspaceId, question: { id: result.question.id, title: result.question.title, recommend: result.question.recommend, big: result.question.big }, mode: result.mode, instruction: result.instruction };
  if (tool === "record_answer" || tool === "withdraw_question") return { workspaceId: result.workspaceId, question: { id: result.question.id, answer: result.question.answer, closed: result.question.closed } };
  if (tool === "set_spec") return { workspaceId: result.workspaceId, spec: result.spec && { url: result.spec.url, title: result.spec.title, source: result.spec.source }, applied: result.applied, message: result.message };
  if (!result?.prs) return result;
  const workspaceId = result.id;
  if (tool === "enroll_workspace") return { workspaceId, goal: result.goal };
  if (tool === "register_pr") { const p = result.prs.find(p => p.key === `${input.repo}#${input.number}`); return { workspaceId, pr: { key: p.key, stack: p.stack, parent: p.parent, disposition: p.disposition } }; }
  if (tool === "update_obligation") return { workspaceId, obligation: result.obligations.find(o => o.id === result.updatedObligationId) };
  if (tool === "acknowledge_batch") { const b = result.batches.find(b => b.id === input.batchId); return { workspaceId, batch: { id: b.id, state: b.state, result: b.result } }; }
  if (tool === "exclude_stack") { const s = result.excludedStacks.find(s => s.name === input.stack); return { workspaceId, excludedStack: { name: s.name, reason: s.reason, prs: s.prs.map(p => p.key) } }; }
  return result;
}
async function loadClient() {
  const candidates = [];
  if (process.env.FOLLOW_THROUGH_CLIENT_ENTRY) candidates.push(() => pathToFileURL(process.env.FOLLOW_THROUGH_CLIENT_ENTRY).href);
  const specifier = "@getpaseo/client/internal/daemon-client";
  if (process.resourcesPath) candidates.push(() => pathToFileURL(createRequire(join(process.resourcesPath, "app.asar/node_modules/@getpaseo/cli/dist/index.js")).resolve(specifier)).href);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const cli = join(directory, process.platform === "win32" ? "paseo.cmd" : "paseo");
    if (existsSync(cli)) candidates.push(() => pathToFileURL(createRequire(realpathSync(cli)).resolve(specifier)).href);
  }
  candidates.push(() => pathToFileURL(createRequire(import.meta.url).resolve(specifier)).href);
  for (const resolve of candidates) try { return await import(resolve()); } catch {}
  throw new Error("Cannot load the installed Paseo client. Reload Follow-through to refresh its runtime connection.");
}
const batchInstructions = "Follow-through batches contain a header with the batchId and ordered tasks. Read workspace_status and refresh live conditions; skip resolved tasks. Process PRs bottom to top, one fully before the next, using the repository's /fix-pr and safe reparent workflow. Validate feedback, verify changes, submit with Graphite --publish, reply/resolve addressed threads and preserve uncommitted work. Post-deploy tasks require verified serving revisions and existing production permissions. Stakeholder update requests are follow-through tasks: retain the original thread, recipient and developer authorization in communication. Use current evidence, distinguish fixed/deployed/verified, and read existing replies before posting. Record the sent replyUrl; a draft or uncertain send stays blocked and must be checked before retrying. Auto authorizes agent delivery only. Acknowledge the header's batchId with acknowledge_batch before finishing (completed with the result, or blocked with the reason), before declare_done for completion batches. Declare Done only after the whole goal and post-merge work are verified. Leave merging and archiving to the developer.";

async function call(method, input) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) throw new Error("This bridge must run inside a Paseo agent (PASEO_AGENT_ID is missing).");
  const { DaemonClient } = await loadClient();
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  let password = process.env.PASEO_PASSWORD;
  if (!password && process.env.PASEO_PASSWORD_FILE) password = (await readFile(process.env.PASEO_PASSWORD_FILE, "utf8")).trim();
  if (!password && home === join(homedir(), ".paseo")) password = await readFile(join(homedir(), "paseo-hub/secrets/daemon-password"), "utf8").then(s => s.trim()).catch(() => undefined);
  const client = new DaemonClient({ url: process.env.PASEO_DAEMON_URL ?? `ws://${config.daemon?.listen ?? "127.0.0.1:6767"}/ws`, clientId: "follow-through-mcp", clientType: "cli", reconnect: { enabled: false }, connectTimeoutMs: 10000, suppressSendErrors: true, ...(password ? { password } : {}) });
  try { await client.connect(); return await client.invokePluginRpc("follow-through", method, { ...input, agentId }); }
  finally { await client.close().catch(() => undefined); }
}

const command = process.argv[2];
if (command === "list" || command === "--help" || command === "help") {
  process.stdout.write(command === "list" ? JSON.stringify({ tools: schemas(toolList(undefined, false, true, false, true)) }, null, 2) + "\n" : "Usage: node mcp.mjs list | call <tool> '<json>' [--compact]\nNative MCP returns compact receipts; workspace_status({detail:full}) requests complete history. CLI calls retain full replies unless --compact is supplied.\n");
} else if (command === "call") {
  try {
    const tool = toolList(undefined, false, await briefEnabled(), false, await actionsEnabled()).find(t => t[0] === process.argv[3]);
    if (!tool) throw new Error("Unknown tool. Run list for names and input schemas.");
    const input = JSON.parse(process.argv[4] ?? "{}");
    validate(input, schemas([tool])[0].inputSchema);
    if (process.argv.slice(5).some(arg => arg !== "--compact")) throw new Error("Unknown CLI option. Use --compact or omit it for a full reply.");
    const result = await call(tool[2], callInput(tool, input));
    process.stdout.write(JSON.stringify(process.argv.includes("--compact") && input.detail !== "full" ? compact(tool[0], input, result) : result, null, 2) + "\n");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (command) {
  console.error("Unknown command. Use list, --help, or call <tool> '<json>'."); process.exitCode = 1;
} else {
  const lines = createInterface({ input: process.stdin });
  let tail = Promise.resolve(), initialized = false, lastScope = null;
  const timer = process.env.PASEO_AGENT_ID ? setInterval(() => {
    void (async () => { const current = `${await scope()}:${await briefEnabled()}:${await actionsEnabled()}`; if (initialized && current !== lastScope) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n"); lastScope = current; })().catch(() => {});
  }, 2000) : null;
  timer?.unref(); lines.on("close", () => { if (timer) clearInterval(timer); });
  lines.on("line", line => {
    tail = tail.then(async () => {
      let request;
      try { request = JSON.parse(line); } catch { return; }
      if (request.id === undefined) return;
      try {
        let result;
        const role = await scope(request.method === "initialize" || request.method === "tools/list");
        const brief = await briefEnabled();
        const acting = await actionsEnabled();
        const available = role ? toolList(role === "recovery", role === "contributor", brief, false, acting) : toolList(false, false, brief, true, acting);
        if (request.method === "initialize") {
          initialized = true; lastScope = `${role}:${brief}:${acting}`;
          result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "paseo-follow-through", version: "0.3.5" }, instructions: (role ? (role === "contributor" ? "Register PRs this session submits, including from secondary git worktrees. Read workspace_status and call sync_workspace before finishing. Goal, task, scope and completion changes remain with the designated main agent." : role === "recovery" ? "Recover tracking metadata from evidence, acknowledge your assigned batch, and leave completion to the main agent." : "Keep workspace follow-through updated after PR submission and scope changes. Read workspace_status after compaction. Track all post-merge work. When a decision needs the developer, ask it with ask_question (lettered options and a recommendation) and follow the question mode in its reply. If you keep a spec artifact for this workspace, register its link once with set_spec. " + batchInstructions) + " Perform bookkeeping silently: no sidebar-update announcements, plugin-status commentary or final sidebar recap. Put receipts and summaries in tools. Report actual work outcomes or decisions/blockers; discuss sidebar status only when explicitly asked." : brief ? "" : "Follow-through tools are available to tracked workspace root agents and active recovery agents; contributor sessions receive PR registration and status tools.") + (brief && role !== "contributor" && role !== "recovery" ? (role ? " " : "") + needsYouInstruction : "") + (acting && role !== "contributor" && role !== "recovery" ? " " + actionInstruction : "") };
        } else if (request.method === "ping") result = {};
        else if (request.method === "tools/list") result = { tools: schemas(available) };
        else if (request.method === "tools/call") {
          const tool = available.find(t => t[0] === request.params?.name);
          try {
            if (!tool) throw new Error("This tool is unavailable for the current agent. Tracking must be active; recovery authority ends after acknowledgment.");
            const input = request.params.arguments ?? {}; validate(input, schemas([tool])[0].inputSchema);
            const value = await call(tool[2], callInput(tool, input));
            result = { content: [{ type: "text", text: JSON.stringify(input.detail === "full" ? value : compact(tool[0], input, value)) }] };
          } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
        } else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); return; }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } }) + "\n"); }
    });
  });
}
