import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every RPC the client calls, read from the client's imports of shared/ contracts: rpc name -> first client file using
 * it. Shared by the agent-parity test (each needs a tool) and the RPC acknowledgement test (each replies fast).
 */
export async function clientRpcs(): Promise<Map<string, string>> {
  const files = [join("index.client.tsx"), ...(await readdir("client")).filter(f => /\.tsx?$/.test(f)).map(f => join("client", f))];
  const found = new Map<string, string>(); // rpc name -> first client file using it
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const m of source.matchAll(/import \{([^}]*)\} from "(\.\.?\/shared\/[\w-]+)"/g)) {
      const names = m[1].split(",").map(n => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(n => /Rpc$/.test(n));
      if (!names.length) continue;
      const mod = await import(join(process.cwd(), m[2].replace(/^\.\.?\//, "") + ".ts"));
      for (const name of names) {
        const contract = mod[name];
        // Host settings (settingsRpc): one entry for the settings document, e.g. settings.display.
        const rpc = typeof contract?.name === "string" ? contract.name : typeof contract?.read?.name === "string" ? contract.read.name.replace(/\.read$/, "") : null;
        assert.ok(rpc, `${file}: ${name} isn't an RPC contract`);
        if (!found.has(rpc)) found.set(rpc, file);
      }
    }
    if (/useSettings\(displayPreferences\)/.test(source) && !found.has("settings.display")) found.set("settings.display", file);
  }
  return found;
}
