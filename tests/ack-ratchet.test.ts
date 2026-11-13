import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { settleTime } from "./support/hanging-host";
import { timeAck } from "./support/ack-ratchet";

/**
 * The flake behind "these exempt RPCs now reply in time" (2026-11-13, `follow.retry-move`): an exempt handler waits on a
 * memoized slow call that an earlier RPC started (`selfInstall()` over the daemon's 10 s connect timeout). When that
 * wait gives up inside the handler's window, the handler settles at once with the failure, and a clock-only ratchet
 * calls the exemption stale. Here the same shape runs on a small scale: the shared wait gives up 50 ms into the call.
 */
function sharedSlowDependency() {
  let giveUps = 0;
  let memo: Promise<never> | null = null;
  /** Start the wait (an earlier RPC did) and have it give up after `ms`, the way the connect timeout does. */
  const startEarlier = (ms: number) => {
    memo = new Promise<never>((_resolve, reject) => setTimeout(() => { giveUps++; memo = null; reject(new Error("Daemon connect timed out")); }, ms));
    memo.catch(() => undefined);
  };
  /** The exempt handler: joins the shared wait, or starts one that hangs for the test's length. */
  const handler = async () => { await (memo ??= new Promise<never>(() => undefined)); };
  return { startEarlier, handler, giveUps: () => giveUps };
}

test("main's flake: a shared wait giving up inside the window reads as a reply in time to the clock", async () => {
  const dep = sharedSlowDependency();
  dep.startEarlier(50);
  const r = await settleTime(dep.handler, 500);
  assert.ok(r.ms !== null && r.error, `the clock alone sees a fast reply (${r.ms} ms, ${r.error})`);
});

test("the ratchet doesn't count that reply: it runs the call again and sees it wait", async () => {
  const dep = sharedSlowDependency();
  dep.startEarlier(50);
  const r = await timeAck(dep.handler, 500, dep.giveUps);
  assert.equal(r.verdict, "late", `the exemption stands: ${JSON.stringify(r)}`);
  assert.equal(r.runs, 2, "the tainted first run was discarded");
});

test("a handler that doesn't wait is fast on its first, clean run", async () => {
  const dep = sharedSlowDependency();
  const r = await timeAck(async () => { await sleep(5); }, 500, dep.giveUps);
  assert.equal(r.verdict, "fast");
  assert.equal(r.runs, 1);
});

test("a fast handler that meets an unrelated give-up on every try is tainted: neither late nor proof", async () => {
  let n = 0;
  const r = await timeAck(async () => { n++; }, 500, () => n);
  assert.equal(r.verdict, "tainted");
  assert.equal(r.runs, 3);
});
