// The harness browser must draw semibold as semibold (release-notes-show-their-bold, invariant 120). Paseo's phone
// layout puts system-ui first; on a machine whose default sans has no bold face, 600 drew exactly like 400, so every
// phone render lost its bold while the DOM said font-weight 600. scripts/harness-fonts.conf fixes the fonts; this
// checks them in the page, so a render never passes on a font that can't show weight.

/** The font stacks the renders use: Paseo's phone layout (system-ui first) and its desktop one. */
export const RENDER_STACKS = ["system-ui", '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'];

/** A canvas ink count for each stack at 400 and 600 in the page. Runs in the browser. */
export const inkByWeight = stacks => stacks.map(stack => {
  const ink = weight => {
    const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 40;
    const ctx = canvas.getContext("2d"); ctx.font = `${weight} 16px ${stack}`; ctx.fillText("Dispatch starts new work", 2, 28);
    let n = 0; for (const v of ctx.getImageData(0, 0, canvas.width, canvas.height).data) if (v) n++;
    return n;
  };
  return { stack, regular: ink(400), semibold: ink(600) };
});

/** Pure: the stacks whose semibold draws no heavier than regular (under 5 % more ink), as one line, or null. */
export function weightProblem(rows) {
  const flat = rows.filter(r => r.semibold < r.regular * 1.05);
  return flat.length ? `the harness browser draws font-weight 600 like 400 in ${flat.map(r => r.stack.split(",")[0]).join(", ")} (no bold face; FONTCONFIG_FILE=${process.env.FONTCONFIG_FILE ?? "unset"}): renders would lose every semibold` : null;
}

/** Checks the fonts in a fresh page of `browser`; returns the problem line, or null when every stack shows weight. */
export async function fontWeightProblem(browser) {
  const page = await browser.newPage();
  try { return weightProblem(await page.evaluate(inkByWeight, RENDER_STACKS)); } finally { await page.close(); }
}
