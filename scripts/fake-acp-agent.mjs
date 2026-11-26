#!/usr/bin/env node
// A fake ACP agent for harness daemons (an-agent-on-any-provider-gets-follow-up): no model, no network beyond the
// MCP servers Paseo hands it. Paseo runs it through its generic ACP provider config
// (`agents.providers.<id> = { extends: "acp", label, command: [node, this file] }`) and speaks ACP over stdio
// (newline-delimited JSON-RPC 2.0).
//
// It records, one JSON line per event, to FAKE_ACP_RECORD:
//   - `spawn`: the FOLLOW_UP_* / PASEO_* variable names (and FOLLOW_UP_* values) its process got;
//   - `initialize`, `session/new`, `session/load`, `session/resume`: the full params (mcpServers, _meta, and any
//     system-prompt field a client might send);
//   - `prompt`: the prompt's text blocks;
//   - `mcp`: on a prompt that names `follow_workspace_status`, the tools listed by every http MCP server it was given
//     and the result of calling that tool on the server that lists it.
// Used by scripts/check-any-provider.mjs.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const RECORD = process.env.FAKE_ACP_RECORD;
const record = (kind, data) => { if (RECORD) appendFileSync(RECORD, JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...data }) + "\n"); };
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const notify = (method, params) => send({ method, params });

record("spawn", {
  argv: process.argv.slice(2),
  envNames: Object.keys(process.env).filter(k => /^(FOLLOW_UP_|PASEO_)/.test(k)).sort(),
  followUpEnv: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FOLLOW_UP_"))),
});

const MODES = { currentModeId: "default", availableModes: [{ id: "default", name: "Default", description: "Asks before edits" }] };
const MODELS = { currentModelId: "acme-1", availableModels: [{ modelId: "acme-1", name: "Acme 1", description: "The fake ACP agent's only model" }] };
const sessions = new Map(); // sessionId -> { mcpServers }
let nextSession = 1;

/** One MCP exchange over streamable HTTP (JSON or SSE replies), as an MCP client would make it. */
async function mcp(server, state, body) {
  const headers = Object.fromEntries((server.headers ?? []).map(h => [h.name, h.value]));
  const response = await fetch(server.url, { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(state.id ? { "mcp-session-id": state.id } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
  state.id = response.headers.get("mcp-session-id") ?? state.id;
  const text = await response.text();
  if (body.id === undefined) return null;
  const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).pop());
  if (json.error) throw new Error(`${body.method}: ${json.error.message}`);
  return json.result;
}

/** Lists every http server's tools, then calls `tool` on the one that has it. */
async function callTool(servers, tool, args = {}) {
  const listed = {}; let result = null; let error = null;
  for (const server of servers.filter(s => s.type === "http" || s.url)) {
    const state = {};
    try {
      await mcp(server, state, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-acp-agent", version: "1" } } });
      await mcp(server, state, { method: "notifications/initialized" });
      const tools = (await mcp(server, state, { id: 2, method: "tools/list" })).tools;
      listed[server.name] = tools.map(t => ({ name: t.name, description: (t.description ?? "").slice(0, 400) }));
      if (!result && tools.some(t => t.name === tool)) result = await mcp(server, state, { id: 3, method: "tools/call", params: { name: tool, arguments: args } });
    } catch (e) { error = `${server.name}: ${e.message}`; }
  }
  return { listed, result, error };
}

async function prompt(id, params) {
  const text = (params.prompt ?? []).filter(b => b.type === "text").map(b => b.text).join("\n");
  record("prompt", { sessionId: params.sessionId, text, blocks: params.prompt?.length ?? 0 });
  let reply = "Fake ACP agent: nothing to do.";
  // "call follow_x {json}": the JSON object after the tool's name (same line) is its arguments.
  const match = /\b(follow_[a-z_]+)\b(?:[ \t]+(\{[^\n]*\}))?/.exec(text);
  if (match) {
    let args = {}; try { if (match[2]) args = JSON.parse(match[2]); } catch { /* not JSON: no arguments */ }
    const out = await callTool(sessions.get(params.sessionId)?.mcpServers ?? [], match[1], args);
    record("mcp", { tool: match[1], ...out });
    reply = out.result ? `Called ${match[1]}: ${out.result.content?.[0]?.text?.slice(0, 200) ?? "(no text)"}` : `Couldn't call ${match[1]}${out.error ? `: ${out.error}` : ""}.`;
  }
  notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } });
  send({ id, result: { stopReason: "end_turn" } });
}

function openSession(id, method, params, sessionId) {
  record(method, { params });
  sessions.set(sessionId, { mcpServers: params.mcpServers ?? [] });
  send({ id, result: { ...(method === "session/new" ? { sessionId } : {}), modes: MODES, models: MODELS } });
  // Paseo's first listCommands waits for this batch.
  setTimeout(() => notify("session/update", { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } }), 10);
}

const handlers = {
  initialize: (id, params) => {
    record("initialize", { params });
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: true, sse: false } }, authMethods: [], agentInfo: { name: "acme-acp", version: "0.0.1" } } });
  },
  authenticate: id => send({ id, result: {} }),
  "session/new": (id, params) => openSession(id, "session/new", params, `acme-${process.pid}-${nextSession++}`),
  "session/load": (id, params) => openSession(id, "session/load", params, params.sessionId),
  "session/resume": (id, params) => openSession(id, "session/resume", params, params.sessionId),
  "session/list": id => send({ id, result: { sessions: [] } }),
  "session/close": id => send({ id, result: {} }),
  "session/set_mode": id => send({ id, result: {} }),
  "session/set_model": id => send({ id, result: {} }),
  "session/set_config_option": id => send({ id, result: { configOptions: [] } }),
  "session/prompt": (id, params) => prompt(id, params).catch(e => send({ id, error: { code: -32603, message: e.message } })),
};

createInterface({ input: process.stdin }).on("line", line => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === undefined) return; // a reply to something we never ask
  const handler = handlers[msg.method];
  if (msg.id === undefined) return; // notifications (session/cancel): nothing to do
  if (handler) handler(msg.id, msg.params ?? {});
  else send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
});
process.stdin.on("end", () => process.exit(0));
