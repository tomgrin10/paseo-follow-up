import { appendFileSync } from "node:fs";

/**
 * Harness-only attribution of daemon requests (scale-check --request-trace <file> sets FOLLOW_UP_REQUEST_TRACE). Each
 * call the worker makes on its DaemonClient is appended as one JSON line { t, pid, method, caller }, the caller being
 * the first frames of the worker's own code, so scripts/request-top.mjs can name the code path behind every request.
 * The client's methods are instance fields (not on its prototype) and the plugin host loads it with its own loader, so
 * a preload can't wrap them; the worker wraps the one client it builds (openDaemon). Off (returns the client itself)
 * unless the variable is set.
 */
export function traceDaemon<T extends object>(client: T, file = process.env.FOLLOW_UP_REQUEST_TRACE): T {
  if (!file) return client;
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || typeof key !== "string" || key === "connect" || key === "close" || key.startsWith("_")) return value;
      return function (this: unknown, ...args: unknown[]) {
        const frames = (new Error().stack ?? "").split("\n").slice(2).map(l => l.trim().replace(/^at /, ""))
          .filter(l => !/node:internal|node_modules|request-trace\.[jt]s/.test(l)).slice(0, 5)
          .map(l => l.replace(/\(?(?:file:\/\/)?\/[^)]*\/([^/)]+:\d+):\d+\)?$/, "$1"));
        try { appendFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, method: key, caller: frames.join(" < ") }) + "\n"); } catch { /* tracing never breaks a call */ }
        return value.apply(this === receiver ? target : this, args);
      };
    },
  });
}
