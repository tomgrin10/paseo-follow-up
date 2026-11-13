// Preloaded (node --require) by scripts/scale-check.mjs --alloc-prof <dir>: V8's sampling heap profiler with objects
// already collected included, so a burst of garbage (not just what stays live, as --heap-prof shows) is attributed to
// the code that allocated it. Writes <dir>/alloc-<pid>-<from>-<to>s.heapprofile for 0–60 s, 60–180 s and 180–300 s of the
// process's life (or FOLLOW_UP_ALLOC_PROF_WINDOWS); read with node scripts/alloc-top.mjs <file>.
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
  // FOLLOW_UP_ALLOC_PROF_WINDOWS="60,180,300,900,1800" (seconds) sets the window ends, for a long idle run
  // (scale-check --data-from --idle 1800: growth shows as later windows still allocating what earlier ones did).
  const ends = (process.env.FOLLOW_UP_ALLOC_PROF_WINDOWS || "60,180,300").split(",").map(Number);
  ends.forEach((to, k) => { const from = k ? ends[k - 1] : 0; setTimeout(() => { dump(from, to).then(() => k < ends.length - 1 ? start() : undefined).catch(() => undefined); }, to * 1000).unref(); });
}
