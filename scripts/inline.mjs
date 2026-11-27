import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
/**
 * What scripts/build.mjs ships for a source file: the file with each import of a plain-JS module under shared/
 * (shared/agent-text.mjs, shared/turn-checks.mjs) replaced by that module's text, once, depth first. The agent hook and
 * the stdio bridge run from the data directory as single files, so they can't import shared/; in the repository they
 * import it like any module. A shared module inlined this way imports nothing but other such modules, and prefixes its
 * private names so they can't collide with the file it lands in (a duplicate name fails the build's syntax check).
 */
const IMPORT = /^import \{[^}]*\} from "(\.{1,2}\/[^"]+\.mjs)";$/;
export function inlineShared(path, root = resolve(import.meta.dirname, ".."), seen = new Set()) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = IMPORT.exec(line);
    const target = m ? resolve(dirname(path), m[1]) : null;
    if (!target || !relative(root, target).startsWith("shared/")) { out.push(line); continue; }
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(`// ---- inlined from ${relative(root, target)} by scripts/build.mjs ----`, ...inlineShared(target, root, seen).split("\n"), `// ---- end of ${relative(root, target)} ----`);
  }
  return out.join("\n");
}
