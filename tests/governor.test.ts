import test from "node:test";
import assert from "node:assert/strict";
import { Governor, pressure, workingSet } from "../server/governor";
import { governorLevel, resourceMeter, resourceText, type Resources } from "../shared/resources";
import { Engine } from "../server/engine";
import { Store } from "../server/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspace } from "./fixtures";

const GB = 1024 ** 3;
function files(values: Record<string, string>) {
  return { values, read: async (path: string) => { if (!(path in values)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return values[path]; } };
}
const psi = (some: number) => `some avg10=0.00 avg60=${some.toFixed(2)} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;

test("reads Paseo's cgroup and the host CPU, and levels follow the thresholds", async () => {
  const g = "/sys/fs/cgroup/system.slice/paseo.service";
  const f = files({ "/proc/self/cgroup": "0::/system.slice/paseo.service\n", [`${g}/memory.high`]: String(28 * GB), [`${g}/memory.current`]: String(14 * GB), [`${g}/memory.pressure`]: psi(0), "/proc/stat": "cpu  100 0 100 800 0 0 0 0 0 0\n", "/proc/pressure/cpu": psi(5) });
  const lines: string[] = [];
  const governor = new Governor(f.read, line => lines.push(line));
  let r = await governor.sample();
  assert.equal(r.memoryPct, 50); assert.equal(r.level, "ok"); assert.equal(r.cpuPct, null, "CPU needs two samples");
  f.values["/proc/stat"] = "cpu  150 0 150 900 0 0 0 0 0 0\n";
  f.values[`${g}/memory.current`] = String(21.5 * GB);
  r = await governor.sample();
  assert.equal(r.cpuPct, 50); assert.equal(r.memoryPct, 77); assert.equal(r.level, "constrained");
  assert.equal(governor.allowsBackground(), false); assert.equal(governor.allowsExtras(), true);
  f.values[`${g}/memory.current`] = String(24 * GB);
  r = await governor.sample(); assert.equal(r.level, "critical"); assert.equal(governor.allowsExtras(), false);
  assert.equal(lines.length, 2, "transitions are logged once each");
  assert.match(lines[0], /ok → constrained/);
});

test("reclaimable cache doesn't count: memory.current above memory.high with a 45% working set is ok", async () => {
  const g = "/sys/fs/cgroup/system.slice/paseo.service";
  // The 2026-11-09 disk scan: ~10 GB inactive_file and 7.7 GB slab_reclaimable charged to paseo.service.
  const stat = `anon ${Math.round(11.8 * GB)}\nfile ${Math.round(12 * GB)}\nactive_file ${1 * GB}\ninactive_file ${10 * GB}\nslab_reclaimable ${Math.round(7.7 * GB)}\nslab_unreclaimable ${200 * 1024 ** 2}\n`;
  const current = Math.round(12.6 * GB) + 10 * GB + Math.round(7.7 * GB);
  const f = files({ "/proc/self/cgroup": "0::/system.slice/paseo.service\n", [`${g}/memory.high`]: String(28 * GB), [`${g}/memory.current`]: String(current), [`${g}/memory.stat`]: stat, [`${g}/memory.pressure`]: psi(0), "/proc/pressure/cpu": psi(0) });
  assert.ok(current > 28 * GB, "memory.current alone is over memory.high");
  const r = await new Governor(f.read, () => {}).sample();
  assert.equal(r.memoryPct, 45); assert.equal(r.level, "ok");
  assert.equal(r.memoryBytes, Math.round(12.6 * GB));
  assert.equal(workingSet(100, null), 100, "without memory.stat it falls back to memory.current");
  assert.equal(workingSet(100, "inactive_file 300\n"), 0, "never negative");
});

test("sustained pressure counts as constrained; unreadable sources are unknown, never over budget", async () => {
  assert.equal(governorLevel({ memoryPct: 40, memoryPressure: 15, cpuPressure: 0 }), "constrained");
  assert.equal(governorLevel({ memoryPct: null, memoryPressure: null, cpuPressure: 70 }), "constrained");
  assert.equal(governorLevel({ memoryPct: null, memoryPressure: null, cpuPressure: null }), "ok");
  const governor = new Governor(files({}).read, () => {});
  const r = await governor.sample();
  assert.deepEqual([r.memoryPct, r.cpuPct, r.level], [null, null, "ok"]);
  assert.equal(pressure("garbage"), null);
  assert.equal(resourceText(r), null, "the meter hides when nothing is readable");
  assert.equal(resourceText({ memoryPct: 72, cpuPct: 40 }), "Paseo memory 72% · CPU 40%");
});

test("the meter's colour, fill and paused caption follow the governor level", () => {
  const GB = 1024 ** 3, now = Date.parse("2026-11-09T14:00:00Z");
  const r = (over: Partial<Resources>): Resources => ({ memoryPct: 40, memoryBytes: 11.2 * GB, memoryHighBytes: 28 * GB, cpuPct: 30, memoryPressure: 0, cpuPressure: 0, level: "ok", at: new Date(now).toISOString(), ...over });
  const ok = resourceMeter(r({}), now)!;
  assert.deepEqual([ok.tone, ok.suffix, ok.pct, ok.stale], ["ok", null, 40, false]);
  assert.equal(ok.label, "Paseo memory 11 of 28 GB, CPU 30%");
  // CPU at 96% alone doesn't pause anything, so no false alarm.
  assert.equal(resourceMeter(r({ cpuPct: 96 }), now)!.tone, "ok");
  // CPU pressure pauses work: the bar shows CPU, not a 40%-full red bar.
  const cpu = resourceMeter(r({ cpuPct: 97, cpuPressure: 70, level: "constrained" }), now)!;
  assert.deepEqual([cpu.tone, cpu.suffix, cpu.pct], ["warning", "· paused", 97]);
  assert.match(cpu.label, /, high\. Follow-up paused background work$/);
  // Memory pressure under 75% still warns, and the bar stays on memory.
  const mem = resourceMeter(r({ memoryPressure: 20, level: "constrained" }), now)!;
  assert.deepEqual([mem.tone, mem.pct], ["warning", 40]);
  const crit = resourceMeter(r({ memoryPct: 88, memoryBytes: 24.6 * GB, level: "critical" }), now)!;
  assert.deepEqual([crit.tone, crit.suffix, crit.text], ["danger", "· paused", "Paseo memory 88% · CPU 30%"]);
  assert.match(crit.label, /^Paseo memory 25 of 28 GB, CPU 30%, critical\. Follow-up paused background work and extras$/);
  const old = resourceMeter(r({ at: new Date(now - 5 * 60_000).toISOString() }), now, () => "13:55")!;
  assert.deepEqual([old.stale, old.text], [true, "Paseo memory 40% · CPU 30% · as of 13:55"]);
  assert.match(old.label, /Last read at 13:55$/);
});

test("a paused engine skips background refresh entirely", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-gov-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(workspace({ enable_auto_sends: true })); });
  let discovered = 0, observed = 0;
  const engine = new Engine(store, { observe: async () => { observed++; return new Map(); } }, { discover: async () => { discovered++; return []; }, observe: async () => ({ busy: false, reason: null, archived: false }), send: async () => {}, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r" }), label: async () => {} });
  let paused = true; engine.paused = () => paused;
  await engine.tick(); await engine.tick();
  assert.deepEqual([discovered, observed, engine.skipped], [0, 0, 2]);
  paused = false; await engine.tick();
  assert.deepEqual([discovered, observed], [1, 1]);
});
