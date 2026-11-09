import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fromAccountRows, fromBudget, fromSubscriptions, NO_USAGE, type Usage } from "../shared/usage";
import { withDaemon } from "./daemon";

/** Smart Session's recorder ticks every minute; reading faster only repeats it. */
export { USAGE_POLL_MS as USAGE_TTL_MS } from "../shared/usage";
import { USAGE_POLL_MS as USAGE_TTL_MS } from "../shared/usage";
/** The file fallback only counts while Smart Session still writes it. */
const FILE_FRESH_MS = 24 * 3_600_000;

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
  async read(): Promise<Usage> {
    if (this.cached && this.now() - this.cached.at < USAGE_TTL_MS) return this.cached.value;
    this.pending ??= this.load().then(value => { this.cached = { at: this.now(), value }; return value; }).finally(() => { this.pending = null; });
    return this.pending;
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
