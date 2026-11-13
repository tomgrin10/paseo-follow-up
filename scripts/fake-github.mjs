import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * The GitHub every harness daemon talks to. Follow-up reads GitHub over in-process HTTPS (server/github-api.ts), so a
 * fake `gh` on PATH only answers writes; reads come here through FOLLOW_UP_GITHUB_API. Each request is answered by
 * the script's own fixture `gh` (`gh api graphql …` / `gh api <path>` with GH_REPO set), so one fixture serves both
 * transports and a check can rewrite it mid-run.
 *
 * Tokens resolve the way the real host does: the account map names an account per owner, and `gh auth token --user`
 * (here FOLLOW_UP_GH_BIN) prints that account's token. A request whose bearer token isn't its owner's token gets a
 * 401, the HTTP form of the fixture's GH_REPO check.
 *
 * 2026-11-11: #116 moved reads off `gh`; check-install's fake `gh` was silently bypassed, the packed plugin asked the
 * real api.github.com and the v2.0.0-rc.3 publish failed. tests/harness-env.test.ts fails when a harness script fakes
 * `gh` without this server.
 */
/**
 * `handle` (optional) answers a request before the fixture `gh` does: { method, path, body, authorization } →
 * { status, body } or undefined to fall through. Issue-report tests use it for writes (issues, comments, contents)
 * and for paths outside a repository (`user`, `search/issues`), which the fixture `gh` can't answer.
 */
export async function fakeGithub({ dir, gh, owners = ["example"], handle, gzip = false }) {
  const tokenOf = owner => `fixture-token-${owner}`;
  const accountMap = join(dir, "gh-account-map"); const auth = join(dir, "gh-auth");
  await writeFile(accountMap, owners.map(o => `${o} fixture-${o}`).join("\n") + "\n");
  await writeFile(auth, `#!/usr/bin/env node\nconst a = process.argv.slice(2); const u = a[a.indexOf("--user") + 1] || "";\nif (a[0] !== "auth" || a[1] !== "token" || !u.startsWith("fixture-")) process.exit(1);\nconsole.log("fixture-token-" + u.slice(8));\n`);
  await chmod(auth, 0o700);
  const requests = [];
  const runGh = (repo, args) => new Promise(resolve => execFile(gh, args, { env: { ...process.env, GH_REPO: repo }, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  const server = createServer(async (req, res) => {
    // gzip: answer compressed when the client accepts it, as api.github.com does (the worker's fetch then inflates every
    // read, which a plain-text fake never exercises).
    const send = (status, body) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      if (gzip && /gzip/.test(req.headers["accept-encoding"] ?? "")) { res.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(gzipSync(text)); return; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(text);
    };
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const graphql = req.method === "POST" && req.url === "/graphql";
      if (handle && !graphql) {
        const answer = await handle({ method: req.method, path: req.url.replace(/^\//, ""), body: raw ? JSON.parse(raw) : undefined, authorization: req.headers.authorization ?? null });
        if (answer) { requests.push({ method: req.method, path: req.url, repo: null }); return send(answer.status, answer.body ?? {}); }
      }
      const body = graphql ? JSON.parse(raw) : null;
      const rest = req.url.replace(/^\//, "");
      const [owner, name] = graphql ? [body.variables?.owner, body.variables?.name] : (rest.match(/^repos\/([^/]+)\/([^/?]+)/) ?? []).slice(1);
      requests.push({ method: req.method, path: req.url, repo: `${owner}/${name}` });
      if (!owner || !name) return send(404, { message: "Not Found" });
      if (req.headers.authorization !== `bearer ${tokenOf(owner)}`) return send(401, { message: "Bad credentials" });
      const args = graphql ? ["api", "graphql", ...Object.entries(body.variables ?? {}).flatMap(([k, v]) => ["-f", `${k}=${v}`]), "-f", `query=${body.query}`] : ["api", rest];
      const { error, stdout, stderr } = await runGh(`${owner}/${name}`, args);
      if (error && !stdout.trim()) return send(502, { message: `fixture gh failed: ${stderr.trim() || error.message}` });
      send(200, stdout);
    } catch (error) { send(500, { message: String(error?.message ?? error) }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, requests,
    /** Merge into harnessEnv's `set`. */
    env: { FOLLOW_UP_GITHUB_API: url, GH_ACCOUNT_MAP: accountMap, FOLLOW_UP_GH_BIN: auth },
    /** Pass as harnessEnv's `strip`: an explicit token would skip the per-owner lookup. */
    strip: ["GH_TOKEN", "GITHUB_TOKEN"],
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
