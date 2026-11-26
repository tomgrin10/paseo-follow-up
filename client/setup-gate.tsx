import { useEffect, useState } from "react";
import { View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "./text";
import { Button, text, type Theme } from "./kit";
import { finishSetupLine, setupOwner, setupPopup } from "../shared/setup-popup";
import { Setup, TITLES, useOnboarding, type SetupDeps } from "./onboarding";
import { ReleaseNotesSheet, useReleaseNotes } from "./release-notes";
import { reopenSetup, resetSetupSession, setupClosed, setupSession, useSetupSession } from "./setup-ui";
import { useViewVersion } from "./view-store";

export { resetSetupSession };

/**
 * Setup's popup (setup-is-one-popup) on whichever Follow-up surface mounts first: Home, the workspace panel or the
 * sidebar item, like What's new. It opens by itself while setup is under way (a first install, or Set up again) and
 * Close hasn't put it away on this device; the done page stays up after Finish. The rules are shared/setup-popup.ts;
 * the steps and their moves are client/onboarding.tsx `Setup`, the same set-onboarding calls agents' tools make.
 */
export function SetupGate({ surface, theme, compact, deps = {} }: { surface: string; theme: Theme; compact: boolean; deps?: Partial<SetupDeps> }) {
  const onboarding = useOnboarding();
  const session = useSetupSession();
  useViewVersion();
  const closed = setupClosed();
  const view = onboarding.data;
  const decision = setupPopup({ view, closed, done: session.done });
  const notes = useReleaseNotes().data;
  const [notesOpen, setNotesOpen] = useState(false);
  // Setup over (finished, skipped, or by an agent): forget Close, so the next Set up again opens the popup by itself.
  useEffect(() => { if (view && !view.show && !session.done) reopenSetup(); }, [view, session.done]);
  useEffect(() => {
    if (decision === "open" && session.owner == null) setupSession.set({ owner: setupOwner(session.owner, surface) });
  }, [decision, session.owner, surface]);
  useEffect(() => () => { if (setupSession.get().owner === surface) setupSession.set({ owner: null }); }, [surface]);
  if (decision !== "open" || session.owner !== surface || !view) return null;
  const full: SetupDeps = {
    openSettings: deps.openSettings ?? (() => undefined), openHome: deps.openHome, name: notes?.name,
    whatsNew: notes ? { version: notes.version, open: () => setNotesOpen(true) } : null,
  };
  return <>
    <Setup theme={theme} compact={compact} view={view} deps={full} />
    {notesOpen && <ReleaseNotesSheet theme={theme} compact={compact} onClose={() => setNotesOpen(false)} />}
  </>;
}

/** Home's one line while Close has put setup away: it names the step setup stopped on and opens the popup there. */
export function FinishSetupLine({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const view = useOnboarding().data;
  useViewVersion();
  const line = finishSetupLine(view, setupClosed());
  if (!line) return null;
  // Where setup stopped, by the step's own title, so the line says what is left.
  const meta = line.step === "intro" ? "Setup hasn't started yet." : `Next: ${TITLES[line.step]}`;
  if (compact) return <Pressable accessibilityRole="button" accessibilityLabel={line.label} accessibilityHint={meta} onPress={reopenSetup}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, marginHorizontal: 16, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: state.pressed ? c.surface2 : c.surface1 })}>
    <Icon name="ListChecks" size={16} color={c.foregroundMuted} />
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text numberOfLines={1} style={t.label}>{line.label}</Text>
      <Text numberOfLines={1} style={t.meta}>{meta}</Text>
    </View>
    <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />
  </Pressable>;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, paddingLeft: 12, paddingRight: 4, paddingVertical: 4, borderRadius: 8, backgroundColor: c.surface1 }}>
    <Icon name="ListChecks" size={14} color={c.foregroundMuted} />
    <Text style={[t.meta, { flex: 1 }]}>{meta}</Text>
    <Button theme={theme} kind="ghost" title={line.label} onPress={reopenSetup} />
  </View>;
}
