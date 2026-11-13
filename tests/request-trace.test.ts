import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceDaemon } from "../server/request-trace";

test("request trace: off unless asked, the client itself", () => {
  const client = { fetchAgents: async () => 1 };
  assert.equal(traceDaemon(client, undefined), client);
});

test("request trace: each call is logged with the worker frames that made it, and still runs", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-trace-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "trace.jsonl");
  // Methods as instance fields, like Paseo's DaemonClient.
  const client = traceDaemon({ seen: [] as string[], fetchAgentTimeline: async function (this: { seen: string[] }, id: string) { this.seen.push(id); return { entries: [] }; }, connect: async () => undefined }, file);
  async function readTurnForTest() { return client.fetchAgentTimeline("agent-a"); }
  assert.deepEqual(await readTurnForTest(), { entries: [] });
  assert.deepEqual(client.seen, ["agent-a"], "the call reaches the client with its receiver");
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(l => JSON.parse(l) as { method: string; caller: string });
  assert.equal(rows.length, 1, "connect isn't a request");
  assert.equal(rows[0]!.method, "fetchAgentTimeline");
  assert.match(rows[0]!.caller, /readTurnForTest/);
});
