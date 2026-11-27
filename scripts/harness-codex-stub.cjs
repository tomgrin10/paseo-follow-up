#!/usr/bin/env node
// No model, network or real account. Keep stdin open so an accidental catalog probe cannot write EPIPE.
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const message = "harness: codex is stubbed; a harness run never reaches the host's real codex (scripts/harness-env.mjs)";
appendFileSync(join(__dirname, "codex.calls.jsonl"), JSON.stringify(process.argv.slice(2)) + "\n");
if (process.argv[2] !== "app-server") { console.error(message); process.exit(127); }
process.stdout.on("error", error => { if (error.code === "EPIPE") process.exit(0); else throw error; });
createInterface({ input: process.stdin }).on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } }) + "\n");
});
