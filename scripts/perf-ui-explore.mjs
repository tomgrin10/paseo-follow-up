// node scripts/perf-ui-explore.mjs <info.json> <outdir> <profile> <step...>: open pages, dump aria snapshots + shots.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { harness } from "./harness.mjs";
import { launch } from "./perf-ui-lib.mjs";
import { homeUrl } from "./ui-home.mjs";

await harness();
const [infoPath, out, profile = "desktop", ...steps] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const info = JSON.parse(readFileSync(infoPath, "utf8"));
const s = await launch({ profile, cpu: 1 });
const { page } = s;
const dump = async name => { writeFileSync(join(out, `${profile}-${name}.aria.txt`), await page.locator("body").ariaSnapshot().catch(e => String(e))); await page.screenshot({ path: join(out, `${profile}-${name}.png`) }); console.log("dumped", name, page.url()); };
try {
  await page.goto(info.origin); await page.waitForTimeout(3000);
  await page.goto(homeUrl(info.origin, info.serverId)); await page.waitForTimeout(8000);
  await page.getByRole("button", { name: "Close", exact: true }).last().click({ timeout: 1500 }).catch(() => {});
  await dump("home");
  for (const step of steps) {
    // step: "goto:<path>" | "click:<role>:<name regex>" | "dump:<name>" | "wait:<ms>"
    const [kind, ...rest] = step.split(":"); const arg = rest.join(":");
    if (kind === "goto") await page.goto(info.origin + arg.replace("{sid}", info.serverId).replace("{ws0}", info.created[0].workspaceId).replace("{a0}", info.created[0].agentId));
    else if (kind === "click") { const [role, ...re] = arg.split(":"); await page.getByRole(role, { name: new RegExp(re.join(":")) }).first().click({ timeout: 15000 }); }
    else if (kind === "clicklast") { const [role, ...re] = arg.split(":"); await page.getByRole(role, { name: new RegExp(re.join(":")) }).last().click({ timeout: 15000 }); }
    else if (kind === "text") await page.getByText(new RegExp(arg)).first().click({ timeout: 15000 });
    else if (kind === "wait") await page.waitForTimeout(Number(arg));
    else if (kind === "dump") await dump(arg);
  }
} finally { await s.browser.close(); }
