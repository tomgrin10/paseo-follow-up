import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeThrough, backupOnce } from "../server/write-through";
import { unregisterClaude } from "../server/mcp-registrations";

// Invariant: a server module that writes a user-owned config file (it names one of them) writes it through
// server/write-through.ts, never with its own rename(): rename() onto a symlink replaces the link.
test("every server module that writes a user config file goes through write-through, not its own rename()", async () => {
  const offenders: string[] = [];
  for (const dir of ["server", "."]) for (const name of (await readdir(dir)).filter(n => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    const path = join(dir, name); if (path === join("server", "write-through.ts")) continue;
    const text = await readFile(path, "utf8");
    if (!/settings\.json|hooks\.json|\.claude\.json|config\.toml/.test(text)) continue;
    const writesUserFileByHand = /\brename\(\s*temporary\s*,\s*(path|target|file)\b/.test(text) || /copyFile\(\s*(path|target)\b/.test(text);
    if (writesUserFileByHand || !/from "\.\/write-through"/.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});
test("writeThrough and backupOnce keep a symlinked directory and file intact and change the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "follow-write-through-"));
  try {
    await mkdir(join(root, "real")); await writeFile(join(root, "real/a.json"), "old");
    await symlink(join(root, "real"), join(root, "dir")); await symlink("a.json", join(root, "real/link.json"));
    await backupOnce(join(root, "dir/link.json"), ".bak"); await backupOnce(join(root, "dir/link.json"), ".bak");
    assert.equal(await writeThrough(join(root, "dir/link.json"), "new"), join(root, "real/a.json"));
    assert.ok((await lstat(join(root, "real/link.json"))).isSymbolicLink()); assert.ok((await lstat(join(root, "dir"))).isSymbolicLink());
    assert.equal(await readFile(join(root, "real/a.json"), "utf8"), "new"); assert.equal(await readFile(join(root, "real/a.json.bak"), "utf8"), "old");
    assert.equal(await writeThrough(join(root, "dir/new.json"), "fresh"), join(root, "real/new.json"));
    assert.deepEqual((await readdir(join(root, "real"))).sort(), ["a.json", "a.json.bak", "link.json", "new.json"], "no temp files left");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("unregistering the old MCP entry from a symlinked .claude.json keeps the link", async () => {
  const root = await mkdtemp(join(tmpdir(), "follow-write-through-"));
  try {
    await writeFile(join(root, "real.json"), JSON.stringify({ mcpServers: { "follow-through": { env: { FOLLOW_THROUGH_MANAGED: "1" } }, keep: {} } }));
    await symlink(join(root, "real.json"), join(root, ".claude.json"));
    assert.equal((await unregisterClaude(join(root, ".claude.json"))).status, "removed");
    assert.ok((await lstat(join(root, ".claude.json"))).isSymbolicLink());
    assert.deepEqual(JSON.parse(await readFile(join(root, "real.json"), "utf8")).mcpServers, { keep: {} });
  } finally { await rm(root, { recursive: true, force: true }); }
});
