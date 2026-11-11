import { chmod, copyFile, lstat, mkdir, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Writers for files the user owns (Claude settings.json, Codex hooks.json and config.toml, .claude.json). Those are
 * often symlinks into a dotfiles repo or a shared account dir, and rename()ing a temp file onto a symlink replaces
 * the link with a regular file (2026-11-10: a harness run cut the seat account off from ~/.claude/settings.json).
 * So every write resolves the path first and does its temp file + rename in the TARGET's directory: a link stays a
 * link and its target changes. A dangling link is refused: Follow-up never creates a missing dotfile target or
 * replaces the link. tests/write-through.test.ts keeps every user-config writer on this module.
 */
export async function writeTarget(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) {
    throw new Error(`${path} is a dangling symlink (to ${await readlink(path)}); Follow-up won't create its target or replace the link. Restore the target or remove the link.`);
  }
  // A new file: still resolve its directory, so a symlinked config dir is written through too.
  const parent = await realpath(dirname(path)).catch(() => dirname(path));
  return join(parent, basename(path));
}

/** Atomically replace the file `path` resolves to. Returns the path written. */
export async function writeThrough(path: string, text: string, mode = 0o600): Promise<string> {
  const target = await writeTarget(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, text, { mode }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => undefined); }
  return target;
}

/** Copy the file `path` resolves to beside its target as `<target><suffix>`, once (an existing backup is kept). */
export async function backupOnce(path: string, suffix: string): Promise<void> {
  const target = await writeTarget(path);
  await copyFile(target, target + suffix, 1).catch(error => { if (error.code !== "EEXIST") throw error; });
  await chmod(target + suffix, 0o600);
}
