import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/**
 * One full, compacting garbage collection, for the worker once its startup work is done (load, migrations, the first
 * engine tick). That work grows V8's young generation and touches pages V8 then keeps pooled, so without it the worker
 * idled at its startup peak: 216-239 MB in the 120-workspace scale check against 152-184 MB with it (1.4.0-beta.23).
 * Paseo starts plugin processes itself, so there's no --expose-gc: the flag is set for one fresh context only, which
 * leaves no `gc` global behind. Returns false where the runtime refuses; the worker carries on either way.
 */
export function compactHeap(): boolean {
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as unknown;
    setFlagsFromString("--no-expose-gc");
    if (typeof gc !== "function") return false;
    gc();
    return true;
  } catch { return false; }
}
