import { useSyncExternalStore } from "react";
import { deviceStorage } from "../shared/settings-nav";
import { SETUP_CLOSED_KEY } from "../shared/setup-popup";

/**
 * Setup's popup in this app session (setup-is-one-popup, client/setup-gate.tsx): which Follow-up surface draws it
 * (`owner`, the first to want it) and whether the done page is up (`done`: after Finish the server already says setup
 * is over). Close is the device's, not the session's: SETUP_CLOSED_KEY in the device's view state, so a put-away popup
 * stays away after a reload until Home's Finish setup line opens it.
 */
type Session = { owner: string | null; done: boolean };
let state: Session = { owner: null, done: false };
const listeners = new Set<() => void>();
export const setupSession = {
  get: () => state,
  set(next: Partial<Session>) { state = { ...state, ...next }; listeners.forEach(l => l()); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};
export const useSetupSession = () => useSyncExternalStore(setupSession.subscribe, setupSession.get, setupSession.get);
/** Tests and a fresh app session: nobody draws the popup, no done page. */
export const resetSetupSession = () => setupSession.set({ owner: null, done: false });

export const setupClosed = () => deviceStorage.get(SETUP_CLOSED_KEY) === "1";
/** Close (X): put the popup away on this device. The server hears nothing; setup stays on its step. */
export const closeSetup = () => deviceStorage.set(SETUP_CLOSED_KEY, "1");
/** Finish setup, Set up again, or setup ending: the next time setup is under way, the popup opens by itself. */
export const reopenSetup = () => { if (deviceStorage.get(SETUP_CLOSED_KEY) === "1") deviceStorage.set(SETUP_CLOSED_KEY, ""); };
