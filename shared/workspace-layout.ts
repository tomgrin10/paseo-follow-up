/**
 * The workspace view's layout (invariant 135, one-workspace-view): one view in Home's pane, the side panel and the
 * main tab, its layout from its own content width only, never from where it is mounted.
 *
 * - under `ROOMY_MIN` (560): one column, dense (icon buttons in the head, 5 recent steps)
 * - `ROOMY_MIN` to `TWO_MIN` (760): one column, roomy (labelled buttons, 6 recent steps)
 * - `TWO_MIN` to `THREE_MIN` (1400): two columns, the left at `AGENT_SHARE`; 8 recent steps
 * - from `THREE_MIN`: three columns; 10 recent steps
 *
 * The left column is Needs you's while anything waits on the developer (it reads first, as in one column), else the
 * agent card's (client/panel.tsx).
 *
 * The head spans every column, and nothing is centred in a max-width box. Cards outside the agent's column go, in
 * priority order, to the shorter column (`placeCards`), so no column ends at half height beside a long one.
 */
export const ROOMY_MIN = 560;
export const TWO_MIN = 760;
export const THREE_MIN = 1400;
/** The agent's column in two columns. */
export const AGENT_SHARE = 0.55;

export type Tier = "dense" | "roomy" | "two" | "three";
export type Layout = { tier: Tier; columns: 1 | 2 | 3; dense: boolean; steps: number };

const STEPS: Record<Tier, number> = { dense: 5, roomy: 6, two: 8, three: 10 };

/** The tier for a content width. 0 (not measured yet) reads as one dense column, the narrowest place. */
export function layoutFor(width: number): Layout {
  const tier: Tier = width >= THREE_MIN ? "three" : width >= TWO_MIN ? "two" : width >= ROOMY_MIN ? "roomy" : "dense";
  return { tier, columns: tier === "three" ? 3 : tier === "two" ? 2 : 1, dense: tier === "dense", steps: STEPS[tier] };
}

/** A card the view places: `column` pins it (the agent's column is 0); without it the card goes to the shorter one. */
export type Placeable = { key: string; column?: number };

/**
 * Which column each card goes to, in order. Pinned cards keep theirs. Each unpinned card goes to the column whose
 * cards so far are shortest, among the columns it may use (every column but the agent's, unless there is only one
 * other). `heights` are the cards' measured heights (0 before the first layout). `previous` keeps a card where it was
 * unless the move gains more than `HYSTERESIS` px, so a card whose height changes with its column's width never
 * flips back and forth.
 */
export const HYSTERESIS = 32;
export function placeCards(cards: readonly Placeable[], columns: number, heights: Readonly<Record<string, number>>, previous: Readonly<Record<string, number>> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  if (columns <= 1) { for (const c of cards) out[c.key] = 0; return out; }
  const total = new Array<number>(columns).fill(0);
  const free = columns === 2 ? [0, 1] : Array.from({ length: columns - 1 }, (_, i) => i + 1);
  for (const card of cards) {
    const h = heights[card.key] ?? 0;
    let col: number;
    if (card.column !== undefined) col = Math.min(card.column, columns - 1);
    else {
      const best = free.reduce((a, b) => total[b]! < total[a]! ? b : a, free[0]!);
      const was = previous[card.key];
      col = was !== undefined && free.includes(was) && total[was]! - total[best]! <= HYSTERESIS ? was : best;
    }
    out[card.key] = col;
    total[col]! += h;
  }
  return out;
}
