import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultTracking, type Project } from "../shared/settings";
import { applyDiscovery } from "../server/discovery";
import { Engine, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import { clock, workspace } from "./fixtures";
import type { State } from "../shared/model";

const project: Project = { projectId: "project", projectKey: "remote:github.com/example/hero-poc", projectDisplayName: "Renamed project", projectRootPath: "/work/hero-poc", projectKind: "git" };
test("repository identity supplies the initial default and explicit overrides survive renaming", () => {
  assert.equal(defaultTracking(project), true); assert.equal(defaultTracking(project, { project: false }), false);
  assert.equal(defaultTracking({ ...project, projectKey: "remote:github.com/example/other", projectDisplayName: "hero-poc" }), false);
  assert.equal(defaultTracking({ ...project, projectKey: "host:local/hero-poc", projectKind: "non_git" }), false);
  assert.equal(defaultTracking({ ...project, projectKey: "remote:github.com/example/other" }, { project: true }), true);
});
test("project enrollment preserves existing records and cannot revive sends, archived workspaces or replace owners", () => {
  const old = workspace({ enable_tracking: false, enable_auto_sends: true });
  const archived = workspace({ id: "archived", archived: true, enable_tracking: false });
  const state: State = { version: 1, workspaces: [old, archived] };
  const row = { id: "workspace", title: "Rollout", mainAgentId: "main-agent", projectId: "project", messageAt: null, enable_default_tracking: true };
  applyDiscovery(state, [row, { ...row, id: "archived" }], clock);
  assert.equal(old.enable_tracking, true); assert.equal(old.enable_auto_sends, false); assert.equal(old.prs.length, 1); assert.equal(archived.enable_tracking, false);
  old.enable_auto_sends = true; applyDiscovery(state, [row], clock); assert.equal(old.enable_auto_sends, true, "preserve an already tracked workspace's explicit Auto choice");
  old.enable_tracking = false; applyDiscovery(state, [{ ...row, mainAgentId: "other" }], clock); assert.equal(old.enable_tracking, false); assert.equal(old.mainAgentId, "main-agent");
});
test("a default can be disabled while discovery is in flight without enrolling or sending", async t => {
  const directory = await mkdtemp(join(tmpdir(), "follow-project-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(r => { started = r; }); const pending = new Promise<void>(r => { release = r; }); let sends = 0;
  const row = { id: "new", title: "New workspace", mainAgentId: "main", projectId: "project", messageAt: null, enable_default_tracking: true };
  const gateway: Gateway = { discover: async () => { started(); await pending; return [row]; }, observe: async () => ({ busy: false, archived: false, reason: null }), send: async () => { sends++; }, prepareRecovery: async () => { throw new Error("No recovery should launch"); }, label: async () => {} };
  const engine = new Engine(store, { observe: async () => new Map() }, gateway, () => clock);
  const tick = engine.tick(); await entered; await store.mutate(s => { s.projectDefaults = { project: false }; }); release(); await tick;
  assert.equal((await store.snapshot()).workspaces.length, 0); assert.equal(sends, 0);
});
test("defaults enroll existing and newly discovered workspaces without dispatch, persist and preserve tracking when turned off", async t => {
  const directory = await mkdtemp(join(tmpdir(), "follow-project-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); let ids = ["existing"]; let sends = 0;
  const gateway: Gateway = { discover: async s => ids.filter(() => s.projectDefaults?.project !== false).map(id => ({ id, title: id, mainAgentId: id + "-main", projectId: "project", messageAt: null, enable_default_tracking: true, history: { candidates: [], goal: null, complete: true, error: null } })), observe: async () => ({ busy: false, archived: false, reason: null }), send: async () => { sends++; }, prepareRecovery: async () => { throw new Error("No recovery should launch"); }, label: async () => {} };
  const engine = new Engine(store, { observe: async () => new Map() }, gateway, () => clock + 70_000);
  await engine.tick(); ids.push("new"); await engine.tick();
  let state = await store.snapshot(); assert.equal(state.workspaces.length, 2); assert.ok(state.workspaces.every(w => w.enable_tracking && !w.enable_auto_sends && w.batches.length === 0)); assert.equal(sends, 0);
  await store.mutate(s => { s.projectDefaults = { project: false }; }); ids.push("later"); await engine.tick();
  state = await new Store(directory).snapshot(); assert.equal(state.projectDefaults?.project, false); assert.equal(state.workspaces.length, 2); assert.ok(state.workspaces.every(w => w.enable_tracking)); assert.equal(sends, 0);
});
