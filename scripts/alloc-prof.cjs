// Preloaded (node --require) by scripts/scale-check.mjs --alloc-prof <dir>: V8's sampling heap profiler with objects
// already collected included, so a burst of garbage (not just what stays live, as --heap-prof shows) is attributed to
// the code that allocated it. Writes <dir>/alloc-<pid>-<from>-<to>s.heapprofile for 0–60 s, 60–180 s and 180–300 s of the
// process's life; read with node scripts/alloc-top.mjs <file>.
const { Session } = require("node:inspector");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.FOLLOW_UP_ALLOC_PROF;
if (dir) {
  const session = new Session(); session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (e, r) => e ? reject(e) : resolve(r)));
  const start = () => post("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const dump = async (from, to) => { const { profile } = await post("HeapProfiler.stopSampling"); writeFileSync(join(dir, `alloc-${process.pid}-${from}-${to}s.heapprofile`), JSON.stringify(profile)); };
  post("HeapProfiler.enable").then(start).catch(() => undefined);
  setTimeout(() => { dump(0, 60).then(start).catch(() => undefined); }, 60_000).unref();
  setTimeout(() => { dump(60, 180).then(start).catch(() => undefined); }, 180_000).unref();
  // 180–300 s: the realistic test:scale send phase (Follow-up's own sends settle before the idle window).
  setTimeout(() => { dump(180, 300).catch(() => undefined); }, 300_000).unref();
}
