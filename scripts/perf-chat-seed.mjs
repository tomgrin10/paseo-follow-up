// node scripts/perf-chat-seed.mjs <info.json>: agent 0's chat gets a turn with three ask_question cards (Q1, Q5, Q29).
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const info = JSON.parse(readFileSync(process.argv[2], "utf8"));
const PROMPT = "Perf check: ask the three open questions";
const ask = (id, n) => ({ item: { type: "tool_call", callId: `perf-ask-${id}`, name: "mcp__paseo__follow_ask_question", status: "completed", error: null,
  detail: { type: "unknown", input: { title: `Perf question ${n}`, question: "Which option should the agent take?" }, output: JSON.stringify({ question: { id, title: `Perf question ${n}` }, instruction: "Keep building with A meanwhile." }) } } });
writeFileSync(join(info.home, "fixture-scripts.json"), JSON.stringify({ [PROMPT]: [ask("Q1", 1), ask("Q5", 2), ask("Q29", 3), { item: { type: "assistant_message", text: "Asked three questions." } }] }));
const c = new DaemonClient({ url: `ws://127.0.0.1:${info.port}/ws`, clientId: "perf-chat-seed", clientType: "cli", reconnect: { enabled: false } });
await c.connect();
await c.sendMessage(info.created[0].agentId, PROMPT, { messageId: `perf-chat-${Date.now()}` });
await new Promise(r => setTimeout(r, 5000));
process.exit(0);
