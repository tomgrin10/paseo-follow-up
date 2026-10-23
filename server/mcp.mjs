#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
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
  ["sync_workspace", "Silently confirm the sidebar matches your work before finishing, after registering owned PRs and substantive tasks. Call even when no changes are needed. Keep the summary in this tool; never announce sync or recap sidebar/plugin status to the developer. Does not declare Done, run recovery, or start repairs. Main agent only.", "follow.sync", { summary: { ...string, minLength: 1, maxLength: 1000 } }, ["summary"]],
  ["enroll_workspace", "Refine this developer-activated workspace's goal. Ownership is initialized by Track this workspace or the project’s default-tracking setting. This tool cannot activate another workspace. Never ask the developer to enter this. Keep the goal concise; new scope reopens completion.", "follow.enroll", { goal: string }, ["goal"]],
  ["register_pr", "Register a PR produced by this workspace. Call after every submission. Register parents first; repeat to update its stack or parent after restacking. Supply a disposition for a deliberately closed PR.", "follow.register-pr", { repo: string, number: integer, stack: string, parentNumber: { type: ["integer", "null"], minimum: 1 }, disposition: string }, ["repo", "number", "stack"]],
  ["exclude_stack", "Correct an unrelated stack registration. Preserve its PRs and requirements in an exclusion audit; future registration is blocked. reason must cite the scope/ownership evidence. obligationIds may include related tasks without PR dependencies. Keep external dependencies separate from owned work.", "follow.exclude-stack", { stack: string, reason: string, obligationIds: array }, ["stack", "reason"]],
  ["update_obligation", "Record concrete follow-through: verification, migrations, decisions or stakeholder replies. Never add approve/merge/deploy checklist tasks. afterPrs uses owner/repo#number keys. Tasks are manual unless explicitly scheduled with trigger={event:\"now\"|\"merge\"|\"deploy\",delayDays:0}. Only set a trigger from the developer’s requested timing; never infer timing from a title or enable_follow_up alone. Merge/deploy triggers require owned afterPrs; delayDays=14 waits fourteen days after the last dependency event. Now requires no PR dependencies or delay. Deployment timing starts at the first verified fully serving observation and remains conservative when history is unknown. Preserve existing trigger fields on updates; trigger=null makes a task manual. Auto controls delivery, not timing or production permissions. For Slack replies, communication records the original threadUrl, recipient, purpose (progress or verified), explicit developer authorization and sent replyUrl. Empty authorization never queues a reply; Auto does not authorize external posts. Use a verify-and-reply task after deployment for the final update. Read the thread first; mark blocked when posting is unavailable or uncertain, never treat a draft as sent. Done requires replyUrl and evidence; preserve fields when updating.", "follow.obligation", { id: string, title: string, status: { type: "string", enum: ["pending", "waiting", "working", "blocked", "done", "waived"] }, afterPrs: array, dependencyStage: { type: "string", enum: ["merged", "deployed"] }, evidence: string, enable_follow_up: boolean, communication, trigger }, ["title", "status"]],
  ["acknowledge_batch", "Record a follow-up result. Complete only after verifying all tasks; blocked surfaces the reason to the developer. Always acknowledge before ending a repair turn. Keep the result within 2000 characters.", "follow.acknowledge", { batchId: string, outcome: { type: "string", enum: ["completed", "blocked"] }, result: { ...string, maxLength: 2000 } }, ["batchId", "outcome", "result"]],
  ["declare_done", "Declare that the workspace goal is fulfilled. Live PR status and remaining obligations are checked; returned blockers must be resolved first. Done labels the workspace but never archives it.", "follow.done", { summary: string }, ["summary"]],
];

function toolList(recovery = process.env.FOLLOW_THROUGH_RECOVERY === "1") { return tools.filter(t => !recovery || !["declare_done", "sync_workspace"].includes(t[0])); }
const schemas = list => list.map(([name, description, , properties, required]) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: name === "workspace_status", destructiveHint: false } }));
async function scope(resolveRecovery = false) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) return null;
  try {
    const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
    const directory = join(home, "plugin-data/follow-through");
    const lease = JSON.parse(await readFile(join(directory, "hooks-enabled.json"), "utf8"));
    if (!(lease.expiresAt > Date.now())) return null;
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    for (const w of state.workspaces) {
      if (!w.enable_tracking || w.archived) continue;
      if (w.mainAgentId === agentId) return process.env.FOLLOW_THROUGH_RECOVERY === "1" ? "recovery" : "main";
      if (w.batches.some(b => b.recipientAgentId === agentId && !b.settledAt && ["sending", "sent", "blocked", "uncertain"].includes(b.state) && b.tasks.every(t => t.kind === "inventory"))) return "recovery";
    }
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
    prs: w.prs.map(p => ({ key: p.key, stack: p.stack, parent: p.parent, disposition: p.disposition, error: p.error, ...(p.snapshot ? { title: p.snapshot.title, state: p.snapshot.state, head: p.snapshot.head, draft: p.snapshot.draft, reviewDecision: p.snapshot.reviewDecision, conflict: p.snapshot.conflict, openThreads: p.snapshot.threads.length, failedChecks: p.snapshot.failedChecks, deployment: p.snapshot.deployment } : {}) })),
    obligations: w.obligations.filter(o => !["done", "waived"].includes(o.status)), completedObligations: w.obligations.filter(o => ["done", "waived"].includes(o.status)).length,
    batches: w.batches.filter(b => !["completed", "cancelled"].includes(b.state)).map(b => ({ id: b.id, state: b.state, tasks: b.tasks, result: b.result, recipientAgentId: b.recipientAgentId, contextPath: b.contextPath })),
    excludedStacks: w.excludedStacks.map(s => ({ name: s.name, reason: s.reason, prs: s.prs.map(p => p.key) })), detail: "summary" };
}
function compact(tool, input, result) {
  if (tool === "workspace_status") return currentWork(result);
  if (tool === "declare_done") return { workspaceId: result.workspace.id, completion: result.workspace.completion, blockers: result.blockers };
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
  process.stdout.write(command === "list" ? JSON.stringify({ tools: schemas(toolList()) }, null, 2) + "\n" : "Usage: node mcp.mjs list | call <tool> '<json>' [--compact]\nNative MCP returns compact receipts; workspace_status({detail:full}) requests complete history. CLI calls retain full replies unless --compact is supplied.\n");
} else if (command === "call") {
  try {
    const tool = toolList().find(t => t[0] === process.argv[3]);
    if (!tool) throw new Error("Unknown tool. Run list for names and input schemas.");
    const input = JSON.parse(process.argv[4] ?? "{}");
    validate(input, schemas([tool])[0].inputSchema);
    if (process.argv.slice(5).some(arg => arg !== "--compact")) throw new Error("Unknown CLI option. Use --compact or omit it for a full reply.");
    const result = await call(tool[2], input);
    process.stdout.write(JSON.stringify(process.argv.includes("--compact") && input.detail !== "full" ? compact(tool[0], input, result) : result, null, 2) + "\n");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (command) {
  console.error("Unknown command. Use list, --help, or call <tool> '<json>'."); process.exitCode = 1;
} else {
  const lines = createInterface({ input: process.stdin });
  let tail = Promise.resolve(), initialized = false, lastScope = null;
  const timer = process.env.PASEO_AGENT_ID ? setInterval(() => {
    void (async () => { const current = await scope(); if (initialized && current !== lastScope) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n"); lastScope = current; })().catch(() => {});
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
        const available = role ? toolList(role === "recovery") : [];
        if (request.method === "initialize") {
          initialized = true; lastScope = role;
          result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "paseo-follow-through", version: "0.1.0" }, instructions: role ? (role === "recovery" ? "Recover tracking metadata from evidence, acknowledge your assigned batch, and leave completion to the main agent." : "Keep workspace follow-through updated after PR submission and scope changes. Read workspace_status after compaction. Track all post-merge work. " + batchInstructions) + " Perform bookkeeping silently: no sidebar-update announcements, plugin-status commentary or final sidebar recap. Put receipts and summaries in tools. Report actual work outcomes or decisions/blockers; discuss sidebar status only when explicitly asked." : "Follow-through tools are available only to a tracked workspace's main agent or active recovery agent." };
        } else if (request.method === "ping") result = {};
        else if (request.method === "tools/list") result = { tools: schemas(available) };
        else if (request.method === "tools/call") {
          const tool = available.find(t => t[0] === request.params?.name);
          try {
            if (!tool) throw new Error("This tool is unavailable for the current agent. Tracking must be active; recovery authority ends after acknowledgment.");
            const input = request.params.arguments ?? {}; validate(input, schemas([tool])[0].inputSchema);
            const value = await call(tool[2], input);
            result = { content: [{ type: "text", text: JSON.stringify(input.detail === "full" ? value : compact(tool[0], input, value)) }] };
          } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
        } else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); return; }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } }) + "\n"); }
    });
  });
}
