import test from "node:test";
import assert from "node:assert/strict";
import { CAP_MS, LOAD_TIMEOUT_MS, PROBATION_MS, QUIET_MS, busyAgents, busyText, probation, quietWindow } from "../shared/update-policy";

const M = 60_000, H = 60 * M;

test("quiet window: waits while anything is busy, then for five idle minutes", () => {
  const agent = [{ kind: "agent" as const, count: 2 }];
  assert.deepEqual(quietWindow({ now: 5 * M, readySince: 0, lastBusyAt: 5 * M, busy: agent }), { install: false, why: "busy", busy: agent, capped: false });
  assert.deepEqual(quietWindow({ now: 9 * M, readySince: 0, lastBusyAt: 5 * M, busy: [] }), { install: false, why: "settling", at: 10 * M });
  assert.deepEqual(quietWindow({ now: 10 * M, readySince: 0, lastBusyAt: 5 * M, busy: [] }), { install: true, why: "quiet" });
  assert.deepEqual(quietWindow({ now: 3 * M, readySince: 0, lastBusyAt: null, busy: [] }), { install: false, why: "settling", at: QUIET_MS }, "found while idle still settles");
  assert.deepEqual(quietWindow({ now: QUIET_MS, readySince: 0, lastBusyAt: null, busy: [] }), { install: true, why: "quiet" });
});

test("quiet window: Follow-up's own work in flight blocks too", () => {
  for (const b of [{ kind: "ranker" as const }, { kind: "about" as const }, { kind: "pr-action" as const, count: 1 }, { kind: "repair" as const, count: 1 }])
    assert.equal(quietWindow({ now: H, readySince: 0, lastBusyAt: null, busy: [b] }).install, false, b.kind);
});

test("quiet window: after 24 h of waiting, the next idle moment is enough; still never mid-turn", () => {
  const busy = [{ kind: "agent" as const, count: 1 }];
  assert.deepEqual(quietWindow({ now: CAP_MS, readySince: 0, lastBusyAt: CAP_MS, busy }), { install: false, why: "busy", busy, capped: true });
  assert.deepEqual(quietWindow({ now: CAP_MS + 1, readySince: 0, lastBusyAt: CAP_MS, busy: [] }), { install: true, why: "cap" });
  assert.equal(quietWindow({ now: CAP_MS - 1, readySince: 0, lastBusyAt: CAP_MS - 2 * M, busy: [] }).install, false, "just before the cap it still wants five idle minutes");
});

test("busy agents: running agents with Follow-up tools only, from list status (no timelines)", () => {
  assert.equal(busyAgents([
    { status: "running", hasFollowTools: true }, { status: "idle", hasFollowTools: true },
    { status: "running", hasFollowTools: false }, { status: "running", hasFollowTools: true, archivedAt: "2026-11-01" },
  ]), 1);
  assert.equal(busyText([{ kind: "agent", count: 2 }, { kind: "ranker" }]), "2 agents are mid-turn and the priority ranker is running");
  assert.equal(busyText([{ kind: "agent", count: 1 }]), "1 agent is mid-turn");
});

const base = { appliedAt: 0, to: "1.4.0-beta.15" };
const running = { status: "running" as const, version: "1.4.0-beta.15", error: null };

test("rollback: a version that fails to load rolls back with Paseo's error", () => {
  assert.deepEqual(probation({ ...base, now: 10_000, plugin: { status: "failed", version: "1.4.0-beta.15", error: "SyntaxError: Unexpected token" }, heartbeat: null }),
    { verdict: "rollback", reason: "It failed to load: SyntaxError: Unexpected token" });
  assert.deepEqual(probation({ ...base, now: LOAD_TIMEOUT_MS, plugin: running, heartbeat: null }), { verdict: "rollback", reason: "It didn't start within two minutes." });
  assert.deepEqual(probation({ ...base, now: M, plugin: running, heartbeat: null }), { verdict: "wait" });
});

test("rollback: an error reported during probation rolls back; a clean run is kept", () => {
  assert.deepEqual(probation({ ...base, now: 2 * M, plugin: running, heartbeat: { version: "1.4.0-beta.15", at: 30_000, error: "state.json unreadable" } }),
    { verdict: "rollback", reason: "It reported an error: state.json unreadable" });
  assert.deepEqual(probation({ ...base, now: 2 * M, plugin: running, heartbeat: { version: "1.4.0-beta.15", at: 30_000, error: null } }), { verdict: "wait" });
  assert.deepEqual(probation({ ...base, now: PROBATION_MS, plugin: running, heartbeat: { version: "1.4.0-beta.15", at: 30_000, error: null } }), { verdict: "ok" });
  assert.deepEqual(probation({ ...base, now: PROBATION_MS, plugin: running, heartbeat: { version: "1.4.0-beta.14", at: 30_000, error: null } }),
    { verdict: "rollback", reason: "It didn't start within two minutes." }, "the old version's heartbeat doesn't count");
  assert.deepEqual(probation({ ...base, now: M, plugin: { status: "disabled", version: null, error: null }, heartbeat: null }), { verdict: "ok" }, "disabled by the developer");
});
