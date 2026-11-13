// Preloaded (node --require) by scripts/scale-check.mjs --request-trace <file>: every call a process makes on Paseo's
// DaemonClient is appended to <file> as one JSON line { t, pid, method, caller }, where caller is the first frames
// outside the client and node itself, so each daemon request (the counting proxy only knows its type) is attributed to
// the code path that sent it (scripts/request-top.mjs summarises a window). Harness only; it changes no behaviour.
const Module = require("node:module");
const { appendFileSync } = require("node:fs");
const file = process.env.FOLLOW_UP_REQUEST_TRACE;
if (file) {
  const wrapped = new WeakSet();
  const caller = frames => frames
    .filter(l => !/request-trace\.cjs|node:internal|daemon-client|@getpaseo/.test(l)).slice(0, 4)
    .map(l => l.trim().replace(/^at /, "").replace(/\(?(?:file:\/\/)?\/[^)]*\/([^/)]+:\d+):\d+\)?$/, "$1")).join(" < ");
  const wrap = Client => {
    if (!Client?.prototype || wrapped.has(Client)) return;
    wrapped.add(Client);
    for (const name of Object.getOwnPropertyNames(Client.prototype)) {
      const d = Object.getOwnPropertyDescriptor(Client.prototype, name);
      if (name === "constructor" || typeof d?.value !== "function") continue;
      const original = d.value;
      Client.prototype[name] = function (...args) {
        // Only calls from outside the client: a client method calling another (even after an await) is one request.
        const frames = (new Error().stack ?? "").split("\n").slice(2);
        if (!/daemon-client|@getpaseo/.test(frames[0] ?? "")) try { appendFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, method: name, caller: caller(frames) }) + "\n"); } catch {}
        return original.apply(this, args);
      };
    }
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const m = load.call(this, request, ...rest);
    if (/daemon-client/.test(request)) try { wrap(m?.DaemonClient); } catch {}
    return m;
  };
}
