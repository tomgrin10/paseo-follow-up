import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

test("request trace: names the worker's frames when the host evaluates the plugin bundle (Paseo's evaluateBundle)", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-trace-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "trace.jsonl");
  const client = traceDaemon({ fetchAgents: async () => [] }, file);
  // Paseo 0.16's bundle-evaluator.js: globalThis.eval(bundle), from a file under node_modules/@getpaseo.
  const host = join(dir, "node_modules", "@getpaseo", "server"); await mkdir(host, { recursive: true });
  await writeFile(join(host, "bundle-evaluator.cjs"), "exports.evaluateBundle = function evaluateBundle(bundle) { return globalThis.eval(bundle); };\n");
  const { evaluateBundle } = createRequire(import.meta.url)(join(host, "bundle-evaluator.cjs")) as { evaluateBundle: (bundle: string) => (c: typeof client) => Promise<unknown> };
  const sweepForTest = evaluateBundle("(function sweepForTest(c) { return c.fetchAgents(); })");
  await sweepForTest(client);
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(l => JSON.parse(l) as { caller: string });
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.caller, /^sweepForTest \(bundle:1\)/);
});
