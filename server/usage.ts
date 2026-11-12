import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fromAccountRows, fromBudget, fromSubscriptions, NO_USAGE, type Usage } from "../shared/usage";
import { withDaemon } from "./daemon";
import { withDeadline } from "./delivery";

/** Smart Session's recorder ticks every minute; reading faster only repeats it. */
export { USAGE_POLL_MS as USAGE_TTL_MS } from "../shared/usage";
import { USAGE_POLL_MS as USAGE_TTL_MS } from "../shared/usage";
/** The file fallback only counts while Smart Session still writes it. */
const FILE_FRESH_MS = 24 * 3_600_000;
/** The longest one read of Smart Session may stay in flight; a silent daemon can't hold the refresh forever. */
const USAGE_DEADLINE_MS = 20_000;

type Invoke = (pluginId: string, method: string, input: unknown) => Promise<unknown>;

/**
 * Reads provider limits from the Smart Session plugin: its `smart-session.subscriptions` RPC (ZeroSub accounts),
 * else `smart-session.budget` (the CLI login), both through the daemon's plugin RPC, which works across plugins on
 * 0.15.2. When the RPC isn't there, the newest rows of its accounts file. Without Smart Session: nothing, no error.
 */
export class UsageReader {
  private cached: { at: number; value: Usage } | null = null;
  private pending: Promise<Usage> | null = null;
  constructor(private paseoHome: string, private invoke: Invoke = (plugin, method, input) => withDaemon(client => (client as unknown as { invokePluginRpc: Invoke }).invokePluginRpc(plugin, method, input)), private now = Date.now) {}
  /** How long a read with nothing cached yet waits for the first answer before replying "no usage" (tests/rpc-cached.test.ts). */
  firstReadMs = 300;
  /**
   * Stale-while-revalidate (2026-11-12: `follow.usage` was the slowest client RPC, p90 2.5 s, because the client
   * polls every USAGE_POLL_MS, the same as the TTL, so every poll missed and waited on Smart Session). A read answers
   * from the last value at once and refreshes after; the client's next poll carries the fresh one. Only a read with
   * nothing cached waits, at most `firstReadMs`.
   */
  async read(): Promise<Usage> {
    if (!this.cached || this.now() - this.cached.at >= USAGE_TTL_MS) void this.refresh();
    if (this.cached) return this.cached.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<Usage>(resolve => { timer = setTimeout(() => resolve(NO_USAGE), this.firstReadMs); timer.unref?.(); });
    return Promise.race([this.refresh(), waited]).finally(() => clearTimeout(timer));
  }
  /** One read of Smart Session at a time; a failure keeps the last value. */
  refresh(): Promise<Usage> {
    this.pending ??= withDeadline(this.load(), USAGE_DEADLINE_MS, "Smart Session didn't answer in time")
      .then(value => { this.cached = { at: this.now(), value }; return value; }, () => this.cached?.value ?? NO_USAGE)
      .finally(() => { this.pending = null; });
    return this.pending;
  }
  /**
   * Calls `onChange` (after a fresh read) when Smart Session writes its accounts files, debounced by `debounceMs`. It
   * watches the directory, not one file, so the monthly file's rollover is seen. Event-driven, no polling; returns
   * null when the directory can't be watched (Smart Session not installed), and the client reads usage itself.
   */
  watch(onChange: () => void, debounceMs = 5_000): { close(): void } | null {
    let watcher: FSWatcher;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      watcher = watch(join(this.paseoHome, "plugin-data", "smart-session"), { persistent: false }, (_event, name) => {
        if (name && !String(name).startsWith("accounts-")) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; void this.refresh().then(() => onChange(), () => undefined); }, debounceMs);
        timer.unref?.();
      });
      watcher.on("error", () => undefined);
    } catch { return null; }
    return { close: () => { if (timer) clearTimeout(timer); watcher.close(); } };
  }
  private async load(): Promise<Usage> {
    try {
      const subs = fromSubscriptions(await this.invoke("smart-session", "smart-session.subscriptions", {}));
      if (subs.length) return { available: true, source: "rpc", accounts: subs };
      const budget = fromBudget(await this.invoke("smart-session", "smart-session.budget", {}));
      if (budget.length) return { available: true, source: "rpc", accounts: budget };
    } catch { /* Not installed, or an older host: try its file. */ }
    return this.fromFile();
  }
  private async fromFile(): Promise<Usage> {
    const now = new Date(this.now());
    const months = [0, 1].map(back => { const d = new Date(now.getFullYear(), now.getMonth() - back, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
    for (const month of months) {
      const text = await readFile(join(this.paseoHome, "plugin-data", "smart-session", `accounts-${month}.jsonl`), "utf8").catch(() => null);
      if (text === null) continue;
      // Only the tail matters: the newest rows per account.
      const accounts = fromAccountRows(text.length > 400_000 ? text.slice(text.indexOf("\n", text.length - 400_000) + 1) : text)
        .filter(a => a.readAt && this.now() - Date.parse(a.readAt) < FILE_FRESH_MS);
      if (accounts.length) return { available: true, source: "file", accounts };
    }
    return NO_USAGE;
  }
}
