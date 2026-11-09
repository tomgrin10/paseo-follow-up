import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopes, scopeWriter } from "../server/scopes";
import { batchSchema, type State } from "../shared/model";
import { clock, workspace } from "./fixtures";

test("scopes: main, contributors and active recovery recipients of tracked workspaces only", () => {
  const recovery = batchSchema.parse({ id: "r", messageId: "m", tasks: [{ key: "inventory:w", kind: "inventory", target: "w", title: "Recover", fingerprint: "1" }], state: "sent", createdAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString(), settledAt: null, attempts: 1, result: "", recipientAgentId: "rec" });
  const state: State = { version: 1, workspaces: [workspace({ id: "w", mainAgentId: "main", contributorAgentIds: ["helper"], batches: [recovery] }), workspace({ id: "off", mainAgentId: "other", enable_tracking: false })] };
  assert.deepEqual(scopes(state), { helper: { role: "contributor", workspaceId: "w" }, rec: { role: "recovery", workspaceId: "w" }, main: { role: "main", workspaceId: "w" } });
});

test("scopes.json is rewritten only when a role changes", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-scopes-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const write = scopeWriter(dir);
  const state: State = { version: 1, workspaces: [workspace({ mainAgentId: "main" })] };
  await write(state); const first = (await stat(join(dir, "scopes.json"))).mtimeMs;
  await new Promise(r => setTimeout(r, 20));
  await write({ ...state, workspaces: [{ ...state.workspaces[0], title: "Renamed" }] });
  assert.equal((await stat(join(dir, "scopes.json"))).mtimeMs, first, "a title change isn't a scope change");
  await write({ ...state, workspaces: [{ ...state.workspaces[0], mainAgentId: "successor" }] });
  assert.ok(JSON.parse(await readFile(join(dir, "scopes.json"), "utf8")).agents.successor);
});
