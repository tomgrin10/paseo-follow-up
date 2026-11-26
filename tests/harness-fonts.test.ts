import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { weightProblem } from "../scripts/font-weights.mjs";

// release-notes-show-their-bold (invariant 120): renders show semibold on every layout. Paseo's phone layout puts
// system-ui first; on a machine whose default sans had no bold face, every phone render drew 600 as 400.

test("the harness browser's fonts put system-ui and sans-serif on a font with a bold face", () => {
  // scripts/harness.mjs isn't imported here: it installs signal handlers on load.
  assert.match(readFileSync(resolve("scripts/harness.mjs"), "utf8"), /export const HARNESS_FONTS = join\(dirname\(fileURLToPath\(import\.meta\.url\)\), "harness-fonts\.conf"\);/);
  const conf = readFileSync(resolve("scripts/harness-fonts.conf"), "utf8");
  assert.match(conf, /<include ignore_missing="yes">\/etc\/fonts\/fonts\.conf<\/include>/, "keeps the machine's own fonts");
  for (const family of ["system-ui", "sans-serif"]) assert.match(conf, new RegExp(`<string>${family}</string></test>\\s*<edit name="family" mode="prepend_first" binding="strong"><string>Liberation Sans</string>`), family);
});

test("harness() points the browser at those fonts", () => {
  const source = readFileSync(resolve("scripts/harness.mjs"), "utf8");
  const body = source.slice(source.indexOf("export async function harness("));
  // Set before the early return for a run already inside a slot (screenshots under harness-slot).
  assert.ok(body.indexOf("process.env.FONTCONFIG_FILE = HARNESS_FONTS") >= 0);
  assert.ok(body.indexOf("process.env.FONTCONFIG_FILE = HARNESS_FONTS") < body.indexOf("if (held || insideSlot"));
});

test("a stack whose semibold draws like regular is a problem; one with a bold face is not", () => {
  assert.equal(weightProblem([{ stack: "system-ui", regular: 1038, semibold: 1271 }, { stack: "-apple-system, Helvetica", regular: 1038, semibold: 1271 }]), null);
  const line = weightProblem([{ stack: "system-ui", regular: 990, semibold: 990 }, { stack: "-apple-system, Helvetica", regular: 1038, semibold: 1271 }]);
  assert.match(line ?? "", /draws font-weight 600 like 400 in system-ui \(/);
  assert.doesNotMatch(line ?? "", /-apple-system/);
});

test("screenshots.mjs refuses to render on a browser that can't show weight", () => {
  const source = readFileSync(resolve("scripts/screenshots.mjs"), "utf8");
  const launch = source.indexOf("browser = await chromium.launch(");
  assert.ok(launch > 0);
  assert.match(source.slice(launch, launch + 600), /await fontWeightProblem\(browser\)[\s\S]*throw new Error\(fontProblem\)/);
});
