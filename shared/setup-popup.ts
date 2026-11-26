import type { OnboardingStep, OnboardingView } from "./onboarding";

/**
 * Setup's popup (setup-is-one-popup, client/setup-gate.tsx): when it opens, when Close has put it away, and Home's
 * "Finish setup" line. Pure: the server's onboarding view says whether setup is under way; `closed` is this device's
 * Close (SETUP_CLOSED_KEY in the device's view state); `done` holds the done page after Finish, when the server
 * already says setup is over. Close never reaches the server: setup stays on its step, and agents' setup tools see the
 * same state as before.
 */

/** The device key Close sets. Finish setup clears it, and so does setup ending (finished or skipped). */
export const SETUP_CLOSED_KEY = "follow-up.setup.closed";

export type SetupPopup = "open" | "closed" | "none";

export function setupPopup({ view, closed, done }: { view: OnboardingView | undefined; closed: boolean; done: boolean }): SetupPopup {
  if (done) return "open";
  if (!view?.show) return "none";
  return closed ? "closed" : "open";
}

/** Home's one line while the popup is put away: it opens setup again on the step it was left on. */
export function finishSetupLine(view: OnboardingView | undefined, closed: boolean): { label: "Finish setup"; step: OnboardingStep } | null {
  return setupPopup({ view, closed, done: false }) === "closed" ? { label: "Finish setup", step: view!.step } : null;
}

/** One popup per app session: the first Follow-up surface to want it draws it; the rest draw nothing. */
export const setupOwner = (owner: string | null, surface: string): string => owner ?? surface;
