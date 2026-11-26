import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Modal as RNModal, View, useWindowDimensions, type ScrollView as NativeScrollView } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { DockedPane } from "./docked-pane";
import { FOLLOW_UP_DOT, FOLLOW_UP_ICON } from "./follow-up-icon";
import { bottomInset, text, type Theme } from "./kit";
import { useReducedMotion } from "./motion";
import { isLight, raised, tint, withAlpha } from "./theme";

/**
 * Setup's popup: one dialog (desktop) or sheet (phone) from the welcome page through the steps to done. Home never
 * draws the steps itself; it keeps a "Finish setup" line that opens this again where it was left.
 *
 * The shell is the What's new dialog's (same dim, card, radius and X) at a fixed height, so moving between steps never
 * resizes it: a header (the mark, "Set up Follow-up", where you are, Close) with a hairline progress rule under it, a
 * scrolling body, and a pinned footer for the moves (both through DockedPane, so on a phone a focused field and its
 * Send stay in view: invariant 43). The welcome and done pages drop the header for a centred cover.
 */

export const SETUP_TITLE = "Set up Follow-up";
const WIDTH = 640; const HEIGHT = 560; const INSET = 32;

/** The mark without its end dot: the tile paints that dot in the brand violet itself. */
const TILE_GLYPH = { svg: FOLLOW_UP_ICON.svg.replace(/<circle cx="20\.01"[^>]*\/>/, "") };

/** The app tile: assets/icon.svg drawn with the host's Icon (the mark in white, its end dot in the brand violet). */
export function FollowUpTile({ size = 64 }: { size?: number }) {
  const glyph = size * 206 / 256; const pad = (size - glyph) / 2; const dot = glyph * 3.84 / 24;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: size, height: size, borderRadius: size * 52 / 256, backgroundColor: "#222126", overflow: "hidden" }}>
    <View style={{ position: "absolute", left: pad, top: pad }}><Icon icon={TILE_GLYPH} size={glyph} color="#ffffff" /></View>
    <View style={{ position: "absolute", left: pad + glyph * FOLLOW_UP_DOT.x - dot / 2, top: pad + glyph * FOLLOW_UP_DOT.y - dot / 2, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: "#B79CF0", zIndex: 1 }} />
  </View>;
}

export type SetupPage = { kind: "cover" } | { kind: "step"; index: number; count: number };

/**
 * The frame. `page` decides the header: a cover page (welcome, done) has none, only Close in the corner; a step has the
 * title row with "2 of 7" and the progress rule. `footer` is the pinned row of moves.
 */
export function SetupShell({ theme, compact, open, page, onClose, footer, scrollRef, children }: {
  theme: Theme; compact: boolean; open: boolean; page: SetupPage; onClose: () => void; footer: ReactNode; scrollRef?: RefObject<NativeScrollView | null>; children: ReactNode;
}) {
  const c = theme.colors; const t = text(c, compact);
  const win = useWindowDimensions();
  const reduced = useReducedMotion();
  const close = useRef<View>(null);
  useEffect(() => { if (open && !compact) (close.current as unknown as { focus?: () => void } | null)?.focus?.(); }, [open, compact]);
  const progress = page.kind === "step" ? (page.index + 1) / page.count : 0;
  const rule = page.kind === "step" && <View accessibilityRole="progressbar" accessibilityLabel={`Step ${page.index + 1} of ${page.count}`}
    accessibilityValue={{ min: 1, max: page.count, now: page.index + 1 }} style={{ height: 2, backgroundColor: c.surface2 }}>
    <View style={{ width: `${progress * 100}%`, height: 2, backgroundColor: withAlpha(c.foreground, 0.7) }} />
  </View>;
  const foot = <View style={[{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: compact ? c.surface1 : c.surface0, flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: compact ? 16 : INSET - 8, paddingTop: compact ? 8 : 12, paddingBottom: compact ? 0 : 12 }, compact ? bottomInset(true) : null]}>{footer}</View>;

  if (compact) return <Modal title={page.kind === "step" ? `${SETUP_TITLE} · ${page.index + 1} of ${page.count}` : SETUP_TITLE} open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }} style={{ flex: 1 }}>
      {rule}
      {/* While a field has focus or the keyboard is up, the footer steps aside (invariant 43). */}
      <DockedPane compact scrollRef={scrollRef as never} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: page.kind === "cover" ? 24 : 16, paddingBottom: 24 }}
        dock={({ yields }) => !yields && foot}>{children}</DockedPane>
    </Modal.Content>
  </Modal>;

  const headerButton = (state: { hovered?: boolean }) => ({ padding: 8, borderRadius: 8, backgroundColor: state.hovered ? c.surface1 : "transparent" });
  const closeButton = <Pressable ref={close} accessibilityRole="button" accessibilityLabel="Close" accessibilityHint="Setup stays where you left it. Finish setup on Follow-up's Home opens it again."
    onPress={onClose} style={state => headerButton(state as { hovered?: boolean })}>
    {state => <Icon name="X" size={16} color={state.pressed ? c.foreground : c.foregroundMuted} />}
  </Pressable>;
  return <RNModal transparent visible={open} animationType={reduced ? "none" : "fade"} onRequestClose={onClose}>
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.55)" }}>
      <View role="dialog" aria-modal aria-label={SETUP_TITLE}
        style={{ width: Math.min(WIDTH, win.width - 48), height: Math.min(HEIGHT, win.height - 48), overflow: "hidden", backgroundColor: c.surface0, borderRadius: 12, borderWidth: 1, borderColor: c.surface2 }}>
        {page.kind === "step"
          ? <View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: INSET, paddingRight: INSET - 16, paddingVertical: 12 }}>
              <Icon icon={FOLLOW_UP_ICON} size={16} color={c.foregroundMuted} />
              <Text role="heading" numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 14, fontWeight: "500" }}>{SETUP_TITLE}</Text>
              <Text style={[t.meta, { fontVariant: ["tabular-nums"] }]}>{`${page.index + 1} of ${page.count}`}</Text>
              {closeButton}
            </View>
            {rule}
          </View>
          : <View style={{ position: "absolute", top: 10, right: 10, zIndex: 1 }}>{closeButton}</View>}
        <DockedPane compact={false} scrollRef={scrollRef as never} style={{ minHeight: 0 }} dock={() => foot}
          contentContainerStyle={{ paddingHorizontal: INSET, paddingTop: page.kind === "cover" ? 32 : 24, paddingBottom: page.kind === "cover" ? 32 : 24, ...(page.kind === "cover" ? { flexGrow: 1, justifyContent: "center" } : null) }}>{children}</DockedPane>
      </View>
    </View>
  </RNModal>;
}

const FEATURES = [
  { icon: "Inbox", title: "Needs you", line: "One list of what only you can decide: a merge, a question, a permission." },
  { icon: "Wrench", title: "Repairs", line: "Review comments, failed checks and conflicts go back to the agent that made the PR." },
  { icon: "MessageCircleQuestion", title: "Questions", line: "Agents ask with options and a recommendation. Your answer goes to their chat." },
  { icon: "CircleCheckBig", title: "Done means done", line: "A workspace is done once its PRs merge and the follow-up checks are finished." },
] as const;

/** The welcome page: the tile, the name, what it does in one line, the four things it does, and how long setup takes. */
export function WelcomeBody({ theme, compact, name }: { theme: Theme; compact: boolean; name: string }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ gap: compact ? 24 : 32 }}>
    <View style={{ alignItems: "center", gap: 14 }}>
      <View style={[{ borderRadius: 16 }, isLight(c) ? { shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } } : { borderWidth: 1, borderColor: withAlpha("#ffffff", 0.08) }]}>
        <FollowUpTile size={compact ? 60 : 64} />
      </View>
      <View style={{ alignItems: "center", gap: 6 }}>
        <Text role="heading" style={{ color: c.foreground, fontSize: compact ? 24 : 26, lineHeight: compact ? 30 : 32, fontWeight: "600", letterSpacing: -0.4 }}>{`Welcome to ${name}`}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: compact ? 15 : 14, lineHeight: compact ? 22 : 21, textAlign: "center", maxWidth: 440 }}>
          It follows your agents' pull requests until the work is done, and asks you only for the decisions.
        </Text>
      </View>
    </View>
    <View style={{ flexDirection: compact ? "column" : "row", flexWrap: "wrap", rowGap: compact ? 16 : 22, columnGap: 24 }}>
      {FEATURES.map(f => <View key={f.title} style={{ width: compact ? "100%" : "47%", flexGrow: 1, flexDirection: "row", gap: 12 }}>
        <View style={{ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", ...raised(c), backgroundColor: c.surface1 }}>
          <Icon name={f.icon} size={16} color={c.foreground} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={t.label}>{f.title}</Text>
          <Text style={t.meta}>{f.line}</Text>
        </View>
      </View>)}
    </View>
    {/* What setup costs, in view before the button that starts it. */}
    <Text style={[t.meta, { textAlign: compact ? "left" : "center" }]}>About two minutes. Nothing goes out on its own until you finish.</Text>
  </View>;
}

export type DoneFact = { icon: string; tone?: "success" | "muted"; line: string };

/** The done page: a quiet green check, what is now true, and the facts setup settled, one per line. */
export function DoneBody({ theme, compact, facts, following = true }: { theme: Theme; compact: boolean; facts: readonly DoneFact[]; following?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ gap: compact ? 24 : 28 }}>
    <View style={{ alignItems: "center", gap: 14 }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: tint(c.statusSuccess, c) }}>
        <Icon name="Check" size={28} color={c.statusSuccess} />
      </View>
      <View style={{ alignItems: "center", gap: 6 }}>
        <Text role="heading" style={{ color: c.foreground, fontSize: compact ? 24 : 26, lineHeight: compact ? 30 : 32, fontWeight: "600", letterSpacing: -0.4 }}>You're set up</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: compact ? 15 : 14, lineHeight: compact ? 22 : 21, textAlign: "center", maxWidth: 420 }}>
          {following ? "Follow-up is watching your workspaces now." : "Follow-up starts with your next workspace."} What needs you shows on Home and in a pill above the chat.
        </Text>
      </View>
    </View>
    <View style={{ ...raised(c), borderRadius: 10, backgroundColor: c.surface1, overflow: "hidden", alignSelf: "center", width: "100%", maxWidth: 480 }}>
      {facts.map((f, i) => <View key={f.line} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: i ? 1 : 0, borderTopColor: c.border }}>
        <Icon name={f.icon} size={16} color={f.tone === "success" ? c.statusSuccess : c.foregroundMuted} />
        <Text style={[t.body, { flex: 1 }]}>{f.line}</Text>
      </View>)}
    </View>
    <Text style={[t.meta, { textAlign: "center" }]}>Change any of this in Follow-up settings. Setup is there too, under General.</Text>
  </View>;
}

/** A quiet text link for the footer's left side ("What's new in 2.5.0", "Skip setup"). */
export function FooterLink({ theme, compact, title, hint, onPress, icon }: { theme: Theme; compact: boolean; title: string; hint?: string; onPress: () => void; icon?: string }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityHint={hint} onPress={onPress} hitSlop={compact ? 0 : 6}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: compact ? 44 : 32, paddingHorizontal: 8, borderRadius: 6, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    {icon && <Icon name={icon} size={14} color={c.foregroundMuted} />}
    <Text style={{ color: c.foregroundMuted, fontSize: compact ? 14 : 12, lineHeight: compact ? 19 : 16, fontWeight: "500" }}>{title}</Text>
  </Pressable>;
}
