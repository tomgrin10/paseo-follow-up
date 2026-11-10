import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Keyboard, Platform, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { followSettingsRpc, onboardingChecksRpc, onboardingRpc, setFollowSettingsRpc, setOnboardingRpc } from "../shared/contracts";
import { displayPreferences } from "../shared/display";
import { ONBOARDING_STEPS, autoSendWrites, checksSummary, type Check, type OnboardingStep, type OnboardingView } from "../shared/onboarding";
import { Button, IconButton, errorText, text, type Theme } from "./kit";
import { ReviewerSettings } from "./reviewers";
import { JobRows } from "./job-rows";
import { SETUP_ORDER } from "../shared/job-rows";
import { ShippingStep } from "./shipping";
import { UpdatesStep } from "./updates";
import { Spinner, useReducedMotion } from "./motion";
import { raised, runningColor, tint, withAlpha, type Colors } from "./theme";

/**
 * Getting started: the steps that take a fresh install to a configured Follow-up. Shown in Home's place while the
 * server says so (fresh install, or "Set up Follow-up again"), never forced on an existing install.
 * Every switch writes through the Settings screen's own RPC or settings document as it changes; the flow itself only
 * saves which step it's on, so a reload resumes there.
 */

export const onboardingKey = ["follow-through", "onboarding"];
const checksKey = ["follow-through", "onboarding-checks"];
const followKey = ["follow-through", "follow-settings"];

/** The server's view of setup. Read once per Home mount (no polling) and refreshed after each action. */
export function useOnboarding() {
  const read = useRpc(onboardingRpc);
  return useQuery({ queryKey: onboardingKey, queryFn: () => read({}), staleTime: Infinity, retry: 1 });
}

export type SetupDeps = {
  /** Opens Follow-up's settings, on a category when given (agents, reviewers, following). */
  openSettings(category?: string): void;
};

const TITLES: Record<OnboardingStep, string> = {
  intro: "Follow-up keeps your agents' PRs moving",
  checks: "Check your setup",
  defaults: "What Follow-up does without asking",
  shipping: "How do you ship PRs?",
  reviewers: "Who should review your PRs?",
  updates: "Keep Follow-up up to date",
  helpers: "Helper agents",
  tour: "Where to find things",
};

/** Bottom clearance on phones. TODO(rebase): kit.tsx's bottomInset from the mobile rework replaces this. */
function bottomPad(compact: boolean): ViewStyle {
  if (!compact) return { paddingBottom: 16 };
  if (Platform.OS === "web") return { paddingBottom: "max(12px, env(safe-area-inset-bottom))" as unknown as number };
  return { paddingBottom: Platform.OS === "ios" ? 34 : 24 };
}

export function Setup({ theme, compact, view, deps }: { theme: Theme; compact: boolean; view: OnboardingView; deps: SetupDeps }) {
  const c = theme.colors; const t = text(c);
  const act = useRpc(setOnboardingRpc); const cache = useQueryClient(); const toast = useToast();
  const [step, setStep] = useState<OnboardingStep>(view.step);
  const index = ONBOARDING_STEPS.indexOf(step);
  const scroll = useRef<ScrollView>(null);
  const follow = useFollowSettings();
  // Checks start on the first frame so step 2 usually opens with its answers in. One cached call, never polled.
  const checks = useChecks();
  const move = useMutation({
    mutationFn: (input: Parameters<typeof act>[0]) => act(input),
    onSuccess: next => { if (!next.show) cache.setQueryData(onboardingKey, next); },
    onError: error => toast.error(errorText(error)),
  });
  const go = (next: OnboardingStep) => { setStep(next); scroll.current?.scrollTo({ y: 0, animated: false }); move.mutate({ action: "step", step: next }); };
  const finish = () => move.mutate({ action: "finish" }, { onSuccess: () => {
    const n = follow.data?.workspaces.filter(w => w.enable_tracking && !w.optedOut).length ?? 0;
    toast.show(n ? `Set up. Following ${n} workspace${n === 1 ? "" : "s"}.` : "Set up. Follow-up starts with your next workspace.", { variant: "success" });
  } });
  const skip = () => move.mutate({ action: "skip" }, { onSuccess: () => toast.show("Setup skipped. Set it up any time from Follow-up settings, General.") });
  const last = index === ONBOARDING_STEPS.length - 1;
  const keyboard = useKeyboardUp(compact);
  const failing = step === "checks" && checks.data ? checksSummary(checks.data.checks).state === "fail" : false;

  const body = step === "intro" ? <IntroStep theme={theme} compact={compact} follow={follow.data ?? null} />
    : step === "checks" ? <ChecksStep theme={theme} compact={compact} checks={checks} deps={deps} />
    : step === "defaults" ? <DefaultsStep theme={theme} compact={compact} held={view.holdsAutoSends} />
    : step === "shipping" ? <ShippingStep theme={theme} compact={compact} />
    : step === "reviewers" ? <ReviewerSettings theme={theme} compact={compact} />
    : step === "updates" ? <UpdatesStep theme={theme} compact={compact} />
    : step === "helpers" ? <HelpersStep theme={theme} compact={compact} deps={deps} />
    : <TourStep theme={theme} compact={compact} />;
  const lead: Record<OnboardingStep, string> = {
    intro: "It follows your agents' pull requests until the work is done, sends fixes back to them, and asks you only for decisions.",
    checks: "Follow-up reads PRs with the GitHub CLI, and its helper agents run on the providers you pick. Checking is free.",
    defaults: "These are on now. Change anything here; it saves as you go, and Settings has the same switches.",
    shipping: "Follow-up merges and tracks PRs the way each repository already works. It picked these; change one if it's wrong.",
    reviewers: "When you press Add reviewers on a PR, Follow-up asks these people. Set a default for all repositories, or a list for one. Until then, PRs without reviewers show in Needs you.",
    updates: "New versions fix problems and add features. Follow-up can install them for you, at a moment when no agent is using it, and goes back to the old version if something breaks.",
    helpers: "Follow-up's own agents. They read, summarise and rank. They never change code or message anyone.",
    tour: "Four places worth knowing. Everything else is in Settings.",
  };
  const column: ViewStyle = { width: "100%", maxWidth: 560, alignSelf: "center", paddingHorizontal: compact ? 16 : 24 };

  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    <View style={[column, { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: compact ? 8 : 20, paddingBottom: 8 }]}>
      <Progress theme={theme} index={index} onPick={i => i < index && go(ONBOARDING_STEPS[i])} />
      <Button theme={theme} compact={compact} kind="ghost" title="Skip setup" accessibilityHint="Leaves setup. Every setting keeps its current value." onPress={skip} disabled={move.isPending} />
    </View>
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      <StepFade key={step} style={[column, { gap: compact ? 14 : 16, paddingTop: compact ? 8 : 20 }]}>
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 20, lineHeight: 26, fontWeight: "600" }}>{TITLES[step]}</Text>
          <Text style={[t.body, { color: c.foregroundMuted, maxWidth: 520 }]}>{lead[step]}</Text>
        </View>
        {body}
      </StepFade>
    </ScrollView>
    {/* While typing a reviewer on a phone the bar steps aside, so Continue never sits over the keyboard. */}
    {!keyboard && <View style={[{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface0, paddingTop: 12 }, bottomPad(compact)]}>
      <View style={[column, { flexDirection: "row", alignItems: "center", gap: 8 }]}>
        {index > 0 && (compact
          ? <IconButton theme={theme} compact icon="ChevronLeft" label="Back" onPress={() => go(ONBOARDING_STEPS[index - 1])} />
          : <Button theme={theme} kind="ghost" icon="ChevronLeft" title="Back" onPress={() => go(ONBOARDING_STEPS[index - 1])} />)}
        {!compact && <View style={{ flex: 1 }} />}
        {step === "reviewers" && <Button theme={theme} compact={compact} kind="ghost" title="Skip, set later" onPress={() => go(ONBOARDING_STEPS[index + 1])} />}
        <Button theme={theme} compact={compact} grow={compact} kind="primary" icon={last ? "Check" : undefined}
          title={last ? "Finish" : failing ? "Continue anyway" : "Continue"} loading={last && move.isPending}
          onPress={() => last ? finish() : go(ONBOARDING_STEPS[index + 1])} />
      </View>
    </View>}
  </View>;
}

/** Phones: whether the on-screen keyboard is up (native events; on the web, the visual viewport shrinking). */
function useKeyboardUp(compact: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!compact) return;
    if (Platform.OS === "web") {
      type Viewport = { height: number; addEventListener(e: "resize", f: () => void): void; removeEventListener(e: "resize", f: () => void): void };
      const vv = (globalThis as { visualViewport?: Viewport }).visualViewport;
      const win = globalThis as unknown as { innerHeight: number };
      if (!vv) return;
      const check = () => setUp(win.innerHeight - vv.height > 150);
      vv.addEventListener("resize", check);
      return () => vv.removeEventListener("resize", check);
    }
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setUp(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setUp(false));
    return () => { show.remove(); hide.remove(); };
  }, [compact]);
  return up;
}

/** "2 of 5" and one short segment per step, drawn like the stack bar but in neutral ink: progress isn't a PR state. */
function Progress({ theme, index, onPick }: { theme: Theme; index: number; onPick: (i: number) => void }) {
  const c = theme.colors; const t = text(c);
  return <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }} accessibilityRole="progressbar" accessibilityLabel={`Step ${index + 1} of ${ONBOARDING_STEPS.length}`}
    accessibilityValue={{ min: 1, max: ONBOARDING_STEPS.length, now: index + 1 }}>
    <Text style={[t.small, { minWidth: 34 }]}>{`${index + 1} of ${ONBOARDING_STEPS.length}`}</Text>
    <View style={{ flex: 1, maxWidth: 220, flexDirection: "row", gap: 3 }}>
      {ONBOARDING_STEPS.map((s, i) => <Pressable key={s} disabled={i >= index} onPress={() => onPick(i)} accessibilityLabel={i < index ? `Back to step ${i + 1}` : undefined}
        hitSlop={{ top: 12, bottom: 12 }} style={{ flex: 1, height: 14, justifyContent: "center" }}>
        <View style={{ height: 3, borderRadius: 2, backgroundColor: i === index ? c.foreground : i < index ? withAlpha(c.foreground, 0.4) : c.border }} />
      </Pressable>)}
    </View>
  </View>;
}

/** Step change: a short fade and rise; reduced motion gets the content at once. */
function StepFade({ children, style }: { children: ReactNode; style: ViewStyle | ViewStyle[] }) {
  const reduced = useReducedMotion();
  const v = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  // Follows `reduced`: if the setting arrives (or changes) mid-fade, the content snaps into place.
  useEffect(() => {
    if (reduced) { v.setValue(1); return; }
    const animation = Animated.timing(v, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" });
    animation.start();
    return () => animation.stop();
  }, [reduced]);
  return <Animated.View style={[style as ViewStyle, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }]}>{children}</Animated.View>;
}

function useFollowSettings() {
  const read = useRpc(followSettingsRpc);
  return useQuery({ queryKey: followKey, queryFn: () => read({}) });
}
function useChecks() {
  const read = useRpc(onboardingChecksRpc);
  return useQuery({ queryKey: checksKey, queryFn: () => read({}), staleTime: 60_000, refetchOnWindowFocus: false, retry: false });
}

const Panel = ({ c, children }: { c: Colors; children: ReactNode }) =>
  <View style={{ ...raised(c), borderRadius: 10, backgroundColor: c.surface1, overflow: "hidden" }}>{children}</View>;

// ---------- 1. what it is ----------

const EXAMPLE = [
  { glyph: "CircleX", tone: "danger", line: "Checks failed on #418", caption: "Follow-up notices" },
  { glyph: "spinner", tone: "running", line: "Repair sent to the agent · 2m", caption: "and sends the fix to the agent that made the PR" },
  { glyph: "CircleCheck", tone: "success", dot: "warning", line: "#418 approved", caption: "then asks you only for the decision" },
] as const;

function IntroStep({ theme, compact, follow }: { theme: Theme; compact: boolean; follow: { workspaces: { enable_tracking: boolean; optedOut: boolean }[] } | null }) {
  const c = theme.colors; const t = text(c);
  const reduced = useReducedMotion();
  // Reduced motion shows the last frame, derived in render so it holds even if the setting arrives after mount.
  const [step, setStep] = useState(0);
  useEffect(() => { if (reduced || step >= 2) return; const id = setTimeout(() => setStep(p => p + 1), 1600); return () => clearTimeout(id); }, [step, reduced]);
  const phase = reduced ? 2 : step;
  const n = follow?.workspaces.filter(w => w.enable_tracking && !w.optedOut).length ?? null;
  const tone = (k: string) => k === "danger" ? c.statusDanger : k === "success" ? c.statusSuccess : runningColor(c);
  const e = EXAMPLE[phase];
  return <View style={{ gap: 14 }}>
    <Panel c={c}>
      <View style={{ padding: compact ? 14 : 16, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={[t.label, { flex: 1 }]}>TKT-1042 Add CSV export</Text>
          <Text style={[t.small, { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: c.surface2 }]}>Example</Text>
        </View>
        {/* The stack bar: #417 merged, #418 the one this example follows. */}
        <View style={{ flexDirection: "row", gap: 3, height: 4 }}>
          <View style={{ flex: 1, borderRadius: 2, backgroundColor: c.foregroundMuted, opacity: 0.55 }} />
          <View style={{ flex: 1, borderRadius: 2, backgroundColor: c.border, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 10, height: 4, borderRadius: 2, backgroundColor: tone(e.tone) }} />
          </View>
        </View>
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 20 }}>
          {e.glyph === "spinner" ? <Spinner color={runningColor(c)} size={14} /> : <Icon name={e.glyph} size={14} color={tone(e.tone)} />}
          <Text style={[t.body, { flex: 1 }]}>{e.line}</Text>
          {phase === 2 && <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, minHeight: 22, borderRadius: 11, backgroundColor: tint(c.statusWarning, c) }}>
            <Icon name="CircleAlert" size={12} color={c.statusWarning} />
            <Text style={{ color: c.statusWarning, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Needs you: Merge #418</Text>
          </View>}
        </View>
      </View>
      {/* What Follow-up did, step by step: the rail fills as the example plays. */}
      <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: compact ? 14 : 16, paddingVertical: 10, gap: 6 }}>
        {EXAMPLE.map((x, i) => <View key={x.line} style={{ flexDirection: "row", alignItems: "center", gap: 8, opacity: i <= phase ? 1 : 0.35 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: i <= phase ? ("dot" in x ? c.statusWarning : tone(x.tone)) : c.border }} />
          <Text style={t.meta}>{x.caption}</Text>
        </View>)}
      </View>
    </Panel>
    <View style={{ gap: 4 }}>
      {[
        ["Inbox", "Needs you", "One list of what only you can decide: a merge, a question, a permission."],
        ["Wrench", "Repairs", "Review comments, conflicts and failed checks go to the workspace's agent in one batch."],
        ["MessageCircleQuestion", "Questions", "Agents ask you here, with options and a recommendation. Your answer goes to their chat."],
      ].map(([icon, title, line]) => <View key={title} style={{ flexDirection: "row", gap: 10, paddingVertical: 6 }}>
        <Icon name={icon} size={16} color={c.foregroundMuted} />
        <View style={{ flex: 1, gap: 1 }}><Text style={t.label}>{title}</Text><Text style={t.meta}>{line}</Text></View>
      </View>)}
    </View>
    {n !== null && <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 36, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surface1 }}>
      <Icon name="Radar" size={14} color={c.foregroundMuted} />
      <Text style={[t.body, { flex: 1 }]}>{n ? `Already following your ${n} workspace${n === 1 ? "" : "s"}. Step 3 lists them.` : "No workspaces yet. Follow-up starts with the next one you create."}</Text>
    </View>}
  </View>;
}

// ---------- 2. checks ----------

function ChecksStep({ theme, compact, checks, deps }: { theme: Theme; compact: boolean; checks: ReturnType<typeof useChecks>; deps: SetupDeps }) {
  const c = theme.colors; const t = text(c);
  const read = useRpc(onboardingChecksRpc); const cache = useQueryClient();
  const again = useMutation({ mutationFn: () => read({ fresh: true }), onSuccess: data => cache.setQueryData(checksKey, data) });
  const busy = checks.isPending || again.isPending;
  const rows = checks.data?.checks ?? null;
  const summary = rows ? checksSummary(rows) : null;
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={[t.meta, { flex: 1 }]}>{busy ? "Checking…" : summary?.line ?? ""}</Text>
      <Button theme={theme} compact={compact} kind="secondary" icon="RefreshCw" title="Check again" loading={again.isPending} disabled={busy} onPress={() => again.mutate()} />
    </View>
    {(checks.error || again.error) && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{errorText(checks.error ?? again.error)}</Text>}
    <Panel c={c}>
      {rows ? rows.map((row, i) => <CheckRow key={row.id} theme={theme} compact={compact} row={row} first={i === 0} checking={again.isPending} deps={deps} />)
        : ["GitHub", "Claude", "Codex", "Agent tools"].map((label, i) => <CheckRow key={label} theme={theme} compact={compact} first={i === 0} checking deps={deps} row={{ id: label, label, state: "pending", detail: "Checking…", fix: null }} />)}
    </Panel>
    {summary?.state === "fail" && <Text style={t.meta}>You can continue anyway. Following and Needs you work without what's missing; each row says what it affects.</Text>}
  </View>;
}

const GLYPH: Record<Check["state"], string> = { ok: "CircleCheck", warn: "CircleAlert", fail: "CircleX", pending: "CircleDashed", off: "CircleMinus" };
function CheckRow({ theme, compact, row, first, checking, deps }: { theme: Theme; compact: boolean; row: Check; first: boolean; checking: boolean; deps: SetupDeps }) {
  const c = theme.colors; const t = text(c); const toast = useToast();
  const [open, setOpen] = useState(false);
  const color = row.state === "ok" ? c.statusSuccess : row.state === "warn" ? c.statusWarning : row.state === "fail" ? c.statusDanger : c.foregroundMuted;
  return <View accessibilityLabel={`${row.label}: ${row.detail}`} style={{ flexDirection: "row", gap: 10, paddingHorizontal: compact ? 14 : 16, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
    <View style={{ paddingTop: 1 }}>{checking ? <Spinner color={c.foregroundMuted} size={16} /> : <Icon name={GLYPH[row.state]} size={16} color={color} />}</View>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <Text style={t.label}>{row.label}</Text>
      <Text style={t.meta}>{row.detail}</Text>
      {row.fix && row.state === "warn" && !open && <Pressable accessibilityRole="button" accessibilityState={{ expanded: false }} onPress={() => setOpen(true)} style={{ minHeight: compact ? 44 : 28, justifyContent: "center", alignSelf: "flex-start" }}>
        <Text style={[t.meta, { color: c.foreground, textDecorationLine: "underline" }]}>How to fix</Text>
      </Pressable>}
      {row.fix && (row.state !== "warn" || open) && <View style={{ gap: 6, marginTop: 4 }}>
        <Text style={[t.meta, { color: c.foreground }]}>{row.fix.text}</Text>
        {row.fix.command && <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", maxWidth: "100%", paddingLeft: 10, borderRadius: 6, backgroundColor: c.surface2 }}>
          <Text selectable numberOfLines={1} style={{ flexShrink: 1, color: c.foreground, fontSize: 12, lineHeight: 17, fontFamily: Platform.OS === "ios" ? "Menlo" : "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{row.fix.command}</Text>
          <IconButton theme={theme} compact={compact} icon="Copy" label={`Copy ${row.fix.command}`} onPress={() => { void copyText(row.fix!.command!).then(() => toast.show("Copied", { variant: "success" }), () => toast.error("Couldn't copy here")); }} />
        </View>}
        {row.fix.settings && <Button theme={theme} compact={compact} kind="ghost" icon="Settings" title="Open Settings → Agents" onPress={() => deps.openSettings(row.fix!.settings!)} />}
      </View>}
    </View>
  </View>;
}

// ---------- 3. what it does on its own ----------

function SwitchRow({ theme, compact, label, hint, value, onChange, disabled, first, children }: { theme: Theme; compact: boolean; label: string; hint: string; value: boolean | null; onChange: (v: boolean) => void; disabled?: boolean; first?: boolean; children?: ReactNode }) {
  const c = theme.colors; const t = text(c);
  const on = !!value;
  return <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on, disabled: disabled || value === null }} aria-checked={on} accessibilityLabel={label} accessibilityHint={hint}
      disabled={disabled || value === null} onPress={() => onChange(!on)}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: compact ? 14 : 16, paddingVertical: 12, minHeight: compact ? 56 : 48, backgroundColor: pressed ? c.surface2 : "transparent" })}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={t.label}>{label}</Text>
        <Text style={t.meta}>{hint}</Text>
      </View>
      <View style={{ width: 36, height: 22, borderRadius: 11, padding: 2, backgroundColor: on ? c.accent : c.surface2, borderWidth: on ? 0 : 1, borderColor: c.border, justifyContent: "center", opacity: value === null ? 0.4 : 1 }}>
        <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: on ? c.accentForeground : c.foregroundMuted, alignSelf: on ? "flex-end" : "flex-start" }} />
      </View>
    </Pressable>
    {children}
  </View>;
}

function DefaultsStep({ theme, compact, held }: { theme: Theme; compact: boolean; held: boolean }) {
  const c = theme.colors; const t = text(c);
  const follow = useFollowSettings(); const write = useRpc(setFollowSettingsRpc); const cache = useQueryClient(); const toast = useToast();
  const display = useSettings(displayPreferences);
  const [all, setAll] = useState(false);
  const change = useMutation({
    mutationFn: async (inputs: Parameters<typeof write>[0][]) => { let last = null; for (const input of inputs) last = await write(input); return last; },
    onSuccess: value => { if (value) cache.setQueryData(followKey, value); void cache.invalidateQueries({ queryKey: ["follow-through", "project-settings"] }); },
    onError: error => toast.error(errorText(error)),
  });
  const data = follow.data;
  const list = data?.workspaces ?? [];
  const followed = list.filter(w => w.enable_tracking && !w.optedOut).length;
  const shown = all || list.length <= 8 ? list : list.slice(0, 5);
  const trust = display.status === "ready" ? display.values.enable_trust_bypass : null;
  const saveDisplay = (patch: Partial<typeof displayPreferences.schema._output>) => {
    if (display.status !== "ready") return;
    void display.save({ ...display.values, ...patch }, display.revision).catch(e => toast.error(errorText(e)));
  };
  return <View style={{ gap: 10 }}>
    {follow.error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{errorText(follow.error)}</Text>}
    <Panel c={c}>
      <SwitchRow first theme={theme} compact={compact} label="Follow every workspace" hint="New and existing workspaces, except any you turn off below." value={data?.enable_follow_every ?? null} disabled={change.isPending}
        onChange={v => change.mutate([{ enable_follow_every: v }])}>
        {list.length > 0 && <View style={{ paddingLeft: compact ? 14 : 16, paddingBottom: 6 }}>
          {shown.map(w => {
            const on = w.enable_tracking && !w.optedOut;
            return <Pressable key={w.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} aria-checked={on} accessibilityLabel={`Follow ${w.title}`} disabled={change.isPending}
              onPress={() => change.mutate([{ workspace: { workspaceId: w.id, follow: !on } }])}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: compact ? 44 : 32, paddingRight: compact ? 14 : 16, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: pressed ? c.surface2 : "transparent" })}>
              <Text style={[t.body, { flex: 1, color: on ? c.foreground : c.foregroundMuted }]}>{w.title}</Text>
              {(!on || w.dormant) && <Text style={t.small}>{on ? "Resting" : "Not followed"}</Text>}
              <View style={{ width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                {on && <Icon name="Check" size={12} color={c.accentForeground} />}
              </View>
            </Pressable>;
          })}
          {shown.length < list.length && <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={{ minHeight: compact ? 44 : 32, justifyContent: "center", borderTopWidth: 1, borderTopColor: c.border }}>
            <Text style={[t.meta, { color: c.foreground }]}>{`Show all ${list.length}`}</Text>
          </Pressable>}
        </View>}
      </SwitchRow>
      <SwitchRow theme={theme} compact={compact} label="Send repairs automatically" value={data?.enable_auto_sends_default ?? null} disabled={change.isPending}
        hint={`Review threads and failed checks go to the workspace's agent on their own, once it's idle. Off: each batch waits for your click.${followed ? ` Here it also applies to the ${followed} already followed.` : ""}${held ? " Nothing goes out on its own until you finish setup." : ""}`}
        onChange={v => change.mutate(autoSendWrites(v, list))} />
      <SwitchRow theme={theme} compact={compact} label="Trust bypass agents" value={trust}
        hint="An agent you started in bypass or full access sometimes still stops on a tool prompt. Follow-up approves those so it keeps going, and logs each one. Off brings the prompts back."
        onChange={v => saveDisplay({ enable_trust_bypass: v })} />
    </Panel>
    <Text style={t.meta}>Follow-up never merges, requests reviewers, archives or messages people on its own.</Text>
  </View>;
}

// ---------- 6. helper agents, 7. where to find things ----------

/** The same job rows as Settings → Agents (client/job-rows.tsx), cheapest first; fills in picks that can't run here. */
function HelpersStep({ theme, compact, deps }: { theme: Theme; compact: boolean; deps: SetupDeps }) {
  const c = theme.colors; const t = text(c);
  return <View style={{ gap: 12 }}>
    <Panel c={c}><JobRows theme={theme} compact={compact} order={SETUP_ORDER} preselect /></Panel>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
      <Text style={t.meta}>Permissions and limits are in </Text>
      <Pressable accessibilityRole="link" accessibilityLabel="Open Follow-up settings, Agents" onPress={() => deps.openSettings("agents")} hitSlop={8} style={{ minHeight: compact ? 44 : 20, justifyContent: "center" }}>
        <Text style={[t.meta, { color: c.foreground, textDecorationLine: "underline" }]}>Settings → Agents</Text>
      </Pressable>
      <Text style={t.meta}>.</Text>
    </View>
  </View>;
}

function TourStep({ theme, compact }: { theme: Theme; compact: boolean }) {
  return <View style={{ gap: 2 }}>
    <TourRow theme={theme} thumb={<ThumbHome c={theme.colors} />} title="Home" line="Follow-up in the sidebar. Every workspace, with what needs you at the top." />
    <TourRow theme={theme} thumb={<ThumbPanel c={theme.colors} />} title="Workspace panel"
      line={compact ? "Tap Follow-up at the top of any workspace: its PRs, tasks and what the agent is doing." : "The Follow-up button in a workspace's header docks its PRs, tasks and what the agent is doing beside the chat."} />
    <TourRow theme={theme} thumb={<ThumbNeeds c={theme.colors} />} title="Needs you" line="The decisions only you can make, one button each. A pill above the chat shows the same." />
    <TourRow theme={theme} thumb={<ThumbAbout c={theme.colors} />} title="Summary" line="One sentence under a workspace's title saying what it's for." />
  </View>;
}

function TourRow({ theme, thumb, title, line }: { theme: Theme; thumb: ReactNode; title: string; line: string }) {
  const c = theme.colors; const t = text(c);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}>
    <View style={{ width: 56, height: 44, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden", padding: 6, gap: 4 }}>{thumb}</View>
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}><Text style={t.label}>{title}</Text><Text style={t.meta}>{line}</Text></View>
  </View>;
}
// Token-drawn thumbnails: the shape of each surface, not a screenshot.
const bar = (c: Colors, w: `${number}%`, color = c.border, h = 3) => <View style={{ width: w, height: h, borderRadius: 2, backgroundColor: color }} />;
const ThumbHome = ({ c }: { c: Colors }) => <>{bar(c, "60%", c.statusWarning)}{bar(c, "90%")}{bar(c, "75%")}{bar(c, "85%")}</>;
const ThumbPanel = ({ c }: { c: Colors }) => <>{bar(c, "55%", c.foregroundMuted)}<View style={{ flexDirection: "row", gap: 2 }}>{bar(c, "30%", c.foregroundMuted, 4)}{bar(c, "30%", c.border, 4)}{bar(c, "30%", c.border, 4)}</View>{bar(c, "80%")}</>;
const ThumbNeeds = ({ c }: { c: Colors }) => <View style={{ flex: 1, borderRadius: 4, borderWidth: 1, borderColor: c.statusWarning, padding: 4, gap: 3 }}>{bar(c, "70%")}<View style={{ width: 16, height: 5, borderRadius: 2, backgroundColor: c.accent }} /></View>;
// The Summary: the title, then one quiet line under it.
const ThumbAbout = ({ c }: { c: Colors }) => <>{bar(c, "60%", c.foregroundMuted, 4)}{bar(c, "90%")}{bar(c, "70%")}</>;

// ---------- existing installs ----------

/** The one quiet line an existing install sees on Home, for a day at most. */
export function SetupOffer({ theme, compact, view }: { theme: Theme; compact: boolean; view: OnboardingView | undefined }) {
  const c = theme.colors; const t = text(c);
  const act = useRpc(setOnboardingRpc); const cache = useQueryClient(); const toast = useToast();
  const run = useMutation({ mutationFn: (action: "restart" | "dismiss-offer") => act({ action }), onSuccess: next => cache.setQueryData(onboardingKey, next), onError: e => toast.error(errorText(e)) });
  if (!view?.offer) return null;
  // Phones: one row in the list's gutter. A title and one meta line that never wrap; the row opens setup, the ✕ beside
  // it dismisses. No second row of buttons under the text.
  if (compact) return <View style={{ flexDirection: "row", alignItems: "center", marginHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Open setup" accessibilityHint="A two-minute setup that checks GitHub and shows what Follow-up does on its own" disabled={run.isPending}
      onPress={() => run.mutate("restart")}
      style={state => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingLeft: 14, paddingRight: 4, paddingVertical: 10, borderTopLeftRadius: 10, borderBottomLeftRadius: 10, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
      {run.isPending && run.variables === "restart" ? <Spinner color={c.foregroundMuted} size={14} label="Opening setup" /> : <Icon name="ListChecks" size={16} color={c.foregroundMuted} />}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={text(c, true).label}>Two-minute setup</Text>
        <Text numberOfLines={1} style={text(c, true).meta}>Checks GitHub, shows what runs on its own</Text>
      </View>
    </Pressable>
    <IconButton theme={theme} compact icon="X" label="Dismiss the setup offer" onPress={() => run.mutate("dismiss-offer")} />
  </View>;
  return <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: compact ? 6 : 10, marginHorizontal: compact ? 12 : 16, paddingLeft: 12, paddingRight: 4, paddingVertical: 4, borderRadius: 8, backgroundColor: c.surface1 }}>
    <View style={{ flex: compact ? undefined : 1, flexDirection: "row", alignItems: "center", gap: 8, paddingTop: compact ? 8 : 0 }}>
      <Icon name="ListChecks" size={14} color={c.foregroundMuted} />
      <Text style={[t.meta, { flex: 1 }]}>Follow-up has a two-minute setup that checks GitHub and shows what it does on its own.</Text>
    </View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, justifyContent: compact ? "flex-end" : undefined }}>
      <Button theme={theme} compact={compact} kind="ghost" title="Open setup" loading={run.isPending && run.variables === "restart"} onPress={() => run.mutate("restart")} />
      <IconButton theme={theme} compact={compact} icon="X" label="Dismiss the setup offer" onPress={() => run.mutate("dismiss-offer")} />
    </View>
  </View>;
}

/** Settings and ⌘K: "Set up Follow-up again" starts the flow from the top and shows it on Home. */
export function useRestartSetup() {
  const act = useRpc(setOnboardingRpc); const cache = useQueryClient();
  return useMemo(() => async () => { const next = await act({ action: "restart" }); cache.setQueryData(onboardingKey, next); return next; }, [act, cache]);
}
