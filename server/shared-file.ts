import { readFile, stat } from "node:fs/promises";

/**
 * Other plugins' state files the worker consults on every workspace observation (Session Guard's pauses, Smart
 * Session's compaction queue), read again only when they change: same inode, size and mtime means the parsed value
 * from last time (observe-reads-shared-files-once-per-tick). 2026-11-12: re-reading both on each of ~96 observations a
 * minute was ~38 MB/min of the live worker's 49 MB/min reads, plus a JSON.parse of ~400 KB each time.
 *
 * The value is shared between callers: treat it as read-only. A missing file is null; read and parse errors are not
 * cached, so the next call tries again.
 */
const cache = new Map<string, { key: string; value: Promise<unknown> }>();

export async function readSharedJson<T>(path: string, parse: (raw: unknown) => T): Promise<T | null> {
  let key: string;
  try { const s = await stat(path, { bigint: true }); key = `${s.ino}:${s.size}:${s.mtimeNs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { cache.delete(path); return null; } throw error; }
  const hit = cache.get(path);
  if (hit?.key === key) return hit.value as Promise<T>;
  const value = readFile(path, "utf8").then(text => parse(JSON.parse(text)));
  cache.set(path, { key, value });
  void value.catch(() => { if (cache.get(path)?.value === value) cache.delete(path); });
  return value;
}
