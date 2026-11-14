import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock } from "node:test";
import { sharedDaemon, SHARED_CLIENT_MAX_MS } from "../server/daemon";
import { TICK_MS } from "../shared/poll";

// Invariant a-running-worker-holds-one-daemon-connection. 2026-11-13 live (2.0.1-beta.4): the worker said hello to the
// daemon 39 times in 12 min (a 5 s idle close). 2.0.1-beta.7, live: with a TICK_MS + 10 s idle close it still closed
// and reopened the connection every 80-130 s (22 hellos in 30 min, the daemon logging "Client closed" each time): the
// loop waits TICK_MS after a tick ends, a tick's daemon calls come before its GitHub reads, and a paused tick calls the
// daemon not at all, so the gap between daemon calls routinely passed the bound.

/** The engine's real loop: daemon calls first, then `work` ms of GitHub reads, then TICK_MS after the tick ends. */
async function ticks(connect: ReturnType<typeof sharedDaemon>, o: { ticks: number; work: number; paused?: Set<number> }) {
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 1_000) { mock.timers.tick(1_000); for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); } };
  for (let tick = 0; tick < o.ticks; tick++) {
    if (!o.paused?.has(tick)) {
      for (let call = 0; call < 3; call++) await connect(async () => null);
      await step(o.work);
    }
    await step(TICK_MS);
  }
}

test("a-running-worker-holds-one-daemon-connection: ticks with slow GitHub reads and a paused tick keep one WebSocket", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    let opened = 0, closed = 0;
    const connect = sharedDaemon(async () => { opened++; return { close: async () => { closed++; } } as never; }, { now: Date.now });
    // Live: 12-30 s of GitHub reads after a tick's daemon calls, and the governor pauses a tick now and then.
    await ticks(connect, { ticks: 10, work: 12_000, paused: new Set([4, 5]) });
    assert.equal(opened, 1, `10 ticks opened ${opened} connections`);
    assert.equal(closed, 0, "and never closed it between ticks");
  } finally { mock.timers.reset(); }
});

test("a-running-worker-holds-one-daemon-connection: only stop, a drop or the max age replaces it", async () => {
  let opened = 0, closed = 0, now = 0;
  const live = { connectionState: { status: "connected" } };
  const connect = sharedDaemon(async () => { opened++; return { ...live, close: async () => { closed++; } } as never; }, { now: () => now });
  await connect(async () => null);
  now += 10 * 60_000; await connect(async () => null);
  assert.deepEqual([opened, closed], [1, 0], "ten quiet minutes don't close it");
  now += SHARED_CLIENT_MAX_MS; await connect(async () => null);
  await new Promise(r => setImmediate(r));
  assert.deepEqual([opened, closed], [2, 1], "past the max age it is replaced");
  live.connectionState.status = "disconnected";
  await assert.rejects(connect(async () => { throw new Error("socket dropped"); }));
  await connect(async () => null);
  await new Promise(r => setImmediate(r));
  assert.deepEqual([opened, closed], [3, 2], "a dropped one is retired at once and the next call opens a fresh one");
});

test("a-running-worker-holds-one-daemon-connection: no idle close exists to drift (structure)", async () => {
  const daemon = await readFile("server/daemon.ts", "utf8");
  const shared = daemon.slice(daemon.indexOf("export function sharedDaemon"), daemon.indexOf("async function openDaemon"));
  assert.doesNotMatch(shared, /setTimeout|idleMs|lastUsed/, "sharedDaemon has no timer or idle bound");
});

test("a-worker-builds-one-daemon-client: every worker daemon call shares the one connection; only openDaemon builds a client", async () => {
  // 2026-11-13 live copy under live load: withDaemon built a DaemonClient per call (turn-end and inbox reads, usage,
  // permission events), 41 WebSockets a minute, while RSS climbed in native memory with a flat JS heap.
  const daemon = await readFile("server/daemon.ts", "utf8");
  assert.equal(daemon.match(/new module\.DaemonClient\(/g)?.length, 1, "server/daemon.ts builds a DaemonClient in one place");
  assert.match(daemon, /async function openDaemon\(\)[^]*?new module\.DaemonClient\(/, "and it is openDaemon, the shared connection's opener");
  assert.match(daemon, /export function withDaemon<T>[^{]*\{\s*return sharedConnect\(work\);/, "withDaemon is the shared connection");
  const { readdir } = await import("node:fs/promises");
  // The worker's own code. The .mjs files (the stdio bridge, the hook, the update watchdog) and their generated
  // server/*-source.ts copies run in other processes.
  const files = ["index.server.ts", ...(await readdir("server")).filter(f => f.endsWith(".ts") && f !== "daemon.ts" && !f.endsWith("-source.ts")).map(f => `server/${f}`)];
  for (const f of files) assert.doesNotMatch(await readFile(f, "utf8"), /new [\w.]*DaemonClient\(/, `${f} builds its own DaemonClient`);
});
