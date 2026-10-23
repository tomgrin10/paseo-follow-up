import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default function contribute(server: PluginServerContext) {
  server.registerProvider({
    id: "followthrough-fixture", label: "Follow-through test agent",
    async status() { return { available: true }; },
    async connect() {
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (e: ProviderEvent) => listeners.forEach(listener => listener(e));
      const capabilities = ["prompt.message", "session.persistence", "session.list", "session.archive", "permission.tool_policy"];
      const sessions = new Map<string, Record<string, string>>();
      return {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async close() { listeners.clear(); },
        async send(input) {
          if (input.type === "catalog") emit({ type: "catalog", requestId: input.requestId, catalog: { models: [{ id: "fixture", label: "Fixture", isDefault: true }], modes: [{ id: "default", label: "Default" }] } });
          else if (input.type === "sessions") emit({ type: "sessions", requestId: input.requestId, sessions: [] });
          else if (input.type === "session.open") {
            sessions.set(input.sessionId, { ...input.config.env, FIXTURE_MARKER: String(input.config.providerOptions?.fixture_marker ?? ""), FIXTURE_MODE: String(input.config.providerOptions?.fixture_mode ?? "rollout"), FIXTURE_GOAL: String(input.config.providerOptions?.fixture_goal ?? "Ship and verify the migration rollout") });
            await writeFile(join(process.env.PASEO_HOME!, `fixture-settings-${input.config.env.PASEO_AGENT_ID}.json`), JSON.stringify(sessions.get(input.sessionId)));
            await writeFile(join(process.env.PASEO_HOME!, `fixture-agent-config-${input.config.env.PASEO_AGENT_ID}.json`), JSON.stringify(input.config));
            await writeFile(join(process.env.PASEO_HOME!, "fixture-config.json"), JSON.stringify({ mcp: Object.keys(input.config.mcpServers), bridge: input.config.env.FOLLOW_THROUGH_CLI, instructions: input.config.systemPrompt }));
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: "core", cwd: input.config.cwd, persistence: { version: 1, data: { sessionId: input.sessionId } } });
            const history = await readFile(join(process.env.PASEO_HOME!, `fixture-history-${input.config.env.PASEO_AGENT_ID}.jsonl`), "utf8").catch(() => "");
            if (input.history === "replay") for (const line of history.trim().split("\n").filter(Boolean))
              emit({ type: "timeline.item", sessionId: input.sessionId, item: JSON.parse(line) });
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          } else if (input.type === "session.prompt") {
            const turnId = randomUUID();
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
            void (async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
            await appendFile(join(process.env.PASEO_HOME!, "fixture-receipts.jsonl"), JSON.stringify({ ...input.prompt, agentId: sessions.get(input.sessionId)!.PASEO_AGENT_ID }) + "\n");
            const text = input.prompt.input.type === "message" ? input.prompt.input.content.filter(c => c.type === "text").map(c => c.text).join("\n") : input.prompt.input.arguments;
            await appendFile(join(process.env.PASEO_HOME!, `fixture-history-${sessions.get(input.sessionId)!.PASEO_AGENT_ID}.jsonl`), JSON.stringify({ id: input.prompt.clientMessageId, type: "user_message", text, messageId: input.prompt.clientMessageId }) + "\n");
            if (text === "Fixture: keep running") return;
            if (text === "Fixture: resume guarded work") await new Promise(resolve => setTimeout(resolve, 7000));
            if (text === "Fixture: fail recovery") { emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "failed", error: { message: "Synthetic recovery failure" } }); return; }
            const inventory = text.includes("Recover workspace PR stacks and remaining work");
            const completion = text.includes("Verify the workspace is finished and declare Done");
            if ((inventory || completion) && sessions.get(input.sessionId)!.FIXTURE_MODE !== "deferred") {
              const { DaemonClient } = require(["@getpaseo", "client", "internal", "daemon-client"].join("/"));
              const client = new DaemonClient({ url: process.env.PASEO_DAEMON_URL!, clientId: "fixture-agent", clientType: "cli", reconnect: { enabled: false } });
              try {
                await client.connect();
                const agentId = sessions.get(input.sessionId)!.PASEO_AGENT_ID;
                const settings = sessions.get(input.sessionId)!;
                if (inventory) {
                  const path = /^Evidence file: (.+)$/m.exec(text)![1];
                  const evidence = JSON.parse(await readFile(path, "utf8"));
                  if (!evidence.mainAgent.id) throw new Error("Recovery evidence has no main agent identity");
                }
                const mode = settings.FIXTURE_MODE;
                const call = (method: string, args: Record<string, unknown>) => client.invokePluginRpc("follow-through", method, { ...args, agentId });
                if (inventory) {
                  const record: any = await call("follow.agent-status", {});
                  await call("follow.enroll", { goal: settings.FIXTURE_GOAL });
                  if (mode === "rollout") {
                    await call("follow.register-pr", { repo: "example/app", number: 1, stack: "Migration rollout" });
                    await call("follow.obligation", { id: record.obligations.find((o: any) => o.title === "Verify deployed revision")?.id, title: "Verify deployed revision", status: "waiting", afterPrs: ["example/app#1"], evidence: record.obligations.find((o: any) => o.title === "Verify deployed revision")?.evidence ?? "", enable_follow_up: false });
                  } else if (mode === "blocked") await call("follow.obligation", { title: "Choose build-time metadata or declared migration owners", status: "blocked", evidence: "Design decision needed before implementation", afterPrs: [], enable_follow_up: false });
                }
                const batchId = /^Follow-through (?:batch|recovery) ([^\n]+)/.exec(text)![1];
                await call("follow.acknowledge", { batchId, outcome: "completed", result: inventory ? "Recovered owned PR and deployment requirement; excluded external reference" : "Goal and deployed revision verified" });
                if (completion) await call("follow.done", { summary: mode === "done" ? "Recovery verified; ready to archive" : "Shipped and verified" });
              } finally { await client.close(); }
            }
            const item = { id: randomUUID(), type: "assistant_message" as const, text: text.includes("Fixture: ship migration") ? "Created https://github.com/example/app/pull/1. This external reference is unrelated: https://github.com/example/unrelated/pull/7. Deployment verification remains." : "The isolated test agent received the follow-through batch." };
            await appendFile(join(process.env.PASEO_HOME!, `fixture-history-${sessions.get(input.sessionId)!.PASEO_AGENT_ID}.jsonl`), JSON.stringify(item) + "\n");
            emit({ type: "timeline.item", sessionId: input.sessionId, item });
            emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
            })().catch(error => emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "failed", error: { message: error.message } }));
          } else if (input.type === "session.interrupt") {
            emit({ type: "request.completed", requestId: input.requestId });
          } else if (input.type === "session.close") {
            emit({ type: "session.closed", sessionId: input.sessionId }); emit({ type: "request.completed", requestId: input.requestId });
          } else if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
        },
      };
    },
  });
  return () => {};
}
