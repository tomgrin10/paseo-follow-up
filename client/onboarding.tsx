import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Platform, View, type ViewStyle, type ScrollView as NativeScrollView } from "react-native";
import { Pressable, Text } from "./text";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { followSettingsRpc, onboardingChecksRpc, onboardingRpc, prWorkflowRpc, setFollowSettingsRpc, setOnboardingRpc } from "../shared/contracts";
import { displayPreferences } from "../shared/display";
import { autoSendWrites, checksSummary, providersReady, setupSteps, shownStep, type Check, type Checks, type OnboardingStep, type OnboardingView } from "../shared/onboarding";
import { Button, IconButton, errorText, text, type Theme } from "./kit";
import { ReviewerSettings } from "./reviewers";
import { JobRows } from "./job-rows";
import { SETUP_ORDER } from "../shared/job-rows";
import { ShippingStep, shippingKey } from "./shipping";
import { useNewRowSetting } from "./new-entry";
import { isMac } from "../shared/search-key";
import { NEW_NAME, NEW_ROW } from "../shared/new-name";
import { UpdatesStep, useUpdates } from "./updates";
import { Spinner, useReducedMotion } from "./motion";
import { raised, runningColor, tint, withAlpha, type Colors } from "./theme";
import { DoneBody, FooterLink, SETUP_TITLE, SetupShell, WelcomeBody, type DoneFact } from "./setup-dialog";
import { closeSetup, setupSession, useSetupSession } from "./setup-ui";

/**
 * Getting started: the steps that take a fresh install to a configured Follow-up. Shown in Home's place while the
 * server says so (fresh install, or "Set up Follow-up again"), never forced on an existing install.
 * Every switch writes through the Settings screen's own RPC or settings document as it changes; the flow itself only
 * saves which step it's on, so a reload resumes there.
 */

export const onboardingKey = ["follow-up", "onboarding"];
const checksKey = ["follow-up", "onboarding-checks"];
const followKey = ["follow-up", "follow-settings"];

/** The server's view of setup. Read once per Home mount (no polling) and refreshed after each action. */
export function useOnboarding() {
  const read = useRpc(onboardingRpc);
  return useQuery({ queryKey: onboardingKey, queryFn: () => read({}), staleTime: Infinity, retry: 1 });
}

export type SetupDeps = {
  /** Opens Follow-up's settings, on a category when given (agents, reviewers, following). */
  openSettings(category?: string): void;
  /** Opens Follow-up's Home (the done page's Go to Home). */
  openHome?(): void;
  /** The plugin's display name, for the welcome page. */
  name?: string;
  /** What's new, one click away on the welcome and done pages: the installed version and how to open the notes. */
  whatsNew?: { version: string; open(): void } | null;
};

export const TITLES: Record<OnboardingStep, string> = {
  intro: "Follow-up keeps your agents' PRs moving",
  checks: "Check your setup",
  defaults: "What Follow-up does without asking",
  shipping: "How do you ship PRs?",
  reviewers: "Who should review your PRs?",
  updates: "Keep Follow-up up to date",
  helpers: "Helper agents",
  tour: "Where to find things",
};

export function Setup({ theme, compact, view, deps }: { theme: Theme; compact: boolean; view: OnboardingView; deps: SetupDeps }) {
  const c = theme.colors; const t = text(c);
  const act = useRpc(setOnboardingRpc); const cache = useQueryClient(); const toast = useToast();
  const [saved, setStep] = useState<OnboardingStep>(view.step);
  const scroll = useRef<NativeScrollView>(null);
  const follow = useFollowSettings();
  // Checks start on the first frame so step 2 usually opens with its answers in. One cached call, never polled.
  const checks = useChecks();
  // Which steps this host has something for (setupSteps): GitHub signed in, repositories seen, an npm install. The
  // reads are the ones those steps make anyway, started here so the count is right by the time they come up.
  const readShipping = useRpc(prWorkflowRpc);
  const shipping = useQuery({ queryKey: shippingKey, queryFn: () => readShipping({}), staleTime: 60_000 });
  const updates = useUpdates();
  const gh = checks.data?.checks.find(row => row.id === "gh");
  const live = useMemo(() => setupSteps({
    github: !gh ? null : gh.state === "ok" ? true : gh.state === "off" ? false : null,
    repos: shipping.data ? shipping.data.repos.length : null,
    npm: updates.data ? updates.data.installKind === "npm" : null,
    providers: providersReady(checks.data?.checks),
  }), [gh?.state, shipping.data?.repos.length, updates.data?.installKind, providersReady(checks.data?.checks)]);
  // Once past the checks the list holds still: a late answer never takes away a step the developer is on or has seen.
  const frozen = useRef<OnboardingStep[] | null>(null);
  const steps = frozen.current ?? live;
  const step = shownStep(saved, steps);
  const index = steps.indexOf(step);
  const move = useMutation({
    mutationFn: (input: Parameters<typeof act>[0]) => act(input),
    // Every answer goes in the cache, so the popup opened again (Finish setup) starts on the step it was left on.
    onSuccess: next => cache.setQueryData(onboardingKey, next),
    onError: error => toast.error(errorText(error)),
  });
  const go = (next: OnboardingStep) => { if (step === "checks" && next !== "intro") frozen.current = steps; else if (next === "intro" || next === "checks") frozen.current = null; setStep(next); scroll.current?.scrollTo({ y: 0, animated: false }); move.mutate({ action: "step", step: next }); };
  // Finish holds the done page up: the server already says setup is over, so the session keeps it (setup-ui.ts).
  const finish = () => { setupSession.set({ done: true }); move.mutate({ action: "finish" }, { onError: () => setupSession.set({ done: false }) }); };
  const ui = useSetupSession();
  // Close only puts the popup away: say where it went, once, in words (the a11y hint says the same).
  const closeUi = () => { closeSetup(); toast.show("Setup stays where you left it. Finish setup on Home opens it again."); };
  const closeDone = () => { setupSession.set({ done: false }); deps.openHome?.(); };
  const skip = () => move.mutate({ action: "skip" }, { onSuccess: () => toast.show("Setup skipped. Set it up any time from Follow-up settings, General.") });
  const last = index === steps.length - 1;
  const failing = step === "checks" && checks.data ? checksSummary(checks.data.checks).state === "fail" : false;

  const body = step === "intro" ? null
    : step === "checks" ? <ChecksStep theme={theme} compact={compact} checks={checks} deps={deps} />
    : step === "defaults" ? <DefaultsStep theme={theme} compact={compact} held={view.holdsAutoSends} />
    : step === "shipping" ? <ShippingStep theme={theme} compact={compact} />
    : step === "reviewers" ? <ReviewerSettings theme={theme} compact={compact} />
    : step === "updates" ? <UpdatesStep theme={theme} compact={compact} />
    : step === "helpers" ? <HelpersStep theme={theme} compact={compact} deps={deps} />
    : <TourStep theme={theme} compact={compact} />;
  const lead: Record<OnboardingStep, string> = {
    intro: "It follows your agents' pull requests until the work is done, sends what needs fixing back to them as repairs, and asks you only for decisions.",
    checks: "Follow-up works with every agent Paseo runs. GitHub is optional: with its CLI, Follow-up also follows your PRs.",
    defaults: "These are on now. Change anything here; it saves as you go, and Settings has the same switches.",
    shipping: "Follow-up merges and tracks PRs the way each repository already works. It picked these; change one if it's wrong.",
    reviewers: "When you press Add reviewers on a PR, Follow-up asks these people. Set a default for all repositories, or a list for one. Until then, PRs without reviewers show in Needs you.",
    updates: "New versions fix problems and add features. Follow-up can install them for you, at a moment when no agent is using it, and goes back to the old version if something breaks.",
    helpers: "Follow-up's own agents. They read, summarise and rank. They never change code or message anyone.",
    tour: "Five places worth knowing. Everything else is in Settings.",
  };

  const gh0 = checks.data?.checks.find(row => row.id === "gh");
  const followed = follow.data?.workspaces.filter(w => w.enable_tracking && !w.optedOut).length ?? 0;
  const facts: DoneFact[] = [
    { icon: "Radar", tone: "success", line: followed ? `Following ${followed} workspace${followed === 1 ? "" : "s"}` : "Following the next workspace you create" },
    { icon: "Send", line: follow.data?.enable_auto_sends_default ? "Repairs go to the agent on their own, once it's idle" : "Repairs wait for your click" },
    { icon: "GitPullRequest", tone: gh0?.state === "ok" ? "success" : "muted", line: gh0?.state === "ok" ? "GitHub connected: Follow-up follows your PRs" : "GitHub not connected: Follow-up works without it" },
  ];
  const whatsNewLink = deps.whatsNew && <FooterLink theme={theme} compact={compact} icon="Gift" title={compact ? "What's new" : `What's new in ${deps.whatsNew.version}`} onPress={deps.whatsNew.open} />;
  if (ui.done) return <SetupShell theme={theme} compact={compact} open page={{ kind: "cover" }} onClose={closeDone} scrollRef={scroll}
    footer={<>{whatsNewLink}<View style={{ flex: 1 }} /><Button theme={theme} compact={compact} grow={compact} kind="primary" title={compact ? "Done" : "Go to Home"} onPress={closeDone} /></>}>
    <StepFade key="done" style={{}}><DoneBody theme={theme} compact={compact} facts={facts} following={followed > 0} /></StepFade>
  </SetupShell>;
  if (step === "intro") return <SetupShell theme={theme} compact={compact} open page={{ kind: "cover" }} onClose={closeUi} scrollRef={scroll}
    footer={<>{whatsNewLink}<View style={{ flex: 1 }} /><Button theme={theme} compact={compact} grow={compact} kind="primary" title={SETUP_TITLE} accessibilityHint="About two minutes. Nothing is sent on its own until you finish." onPress={() => go(steps[1])} /></>}>
    <StepFade key="intro" style={{}}><WelcomeBody theme={theme} compact={compact} name={deps.name ?? "Follow-up"} /></StepFade>
  </SetupShell>;
  return <SetupShell theme={theme} compact={compact} open page={{ kind: "step", index: index - 1, count: steps.length - 1 }} onClose={closeUi} scrollRef={scroll}
    footer={<>
      {!compact && <FooterLink theme={theme} compact={compact} title="Skip setup" hint="Leaves setup. Every setting keeps its current value." onPress={skip} />}
      {compact && <IconButton theme={theme} compact icon="ChevronLeft" label="Back" onPress={() => go(steps[index - 1])} />}
      <View style={{ flex: compact ? 0 : 1 }} />
      {!compact && <Button theme={theme} kind="ghost" icon="ChevronLeft" title="Back" onPress={() => go(steps[index - 1])} />}
      {step === "reviewers" && <Button theme={theme} compact={compact} kind="ghost" title="Skip, set later" onPress={() => go(steps[index + 1])} />}
      <Button theme={theme} compact={compact} grow={compact} kind="primary" icon={last ? "Check" : undefined}
        title={last ? "Finish" : failing ? "Continue anyway" : "Continue"} loading={last && move.isPending}
        onPress={() => last ? finish() : go(steps[index + 1])} />
    </>}>
    <StepFade key={step} style={{ gap: compact ? 14 : 16 }}>
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 20, lineHeight: 26, fontWeight: "600" }}>{TITLES[step]}</Text>
        <Text style={[t.body, { color: c.foregroundMuted }]}>{lead[step]}</Text>
      </View>
      {body}
    </StepFade>
  </SetupShell>;
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
  const pendingSince = useRef(0);
  // While Paseo is still loading a provider, ask again every few seconds (fresh), at most a minute; never otherwise.
  return useQuery({ queryKey: checksKey, queryFn: () => read(pendingSince.current ? { fresh: true } : {}), staleTime: 60_000, refetchOnWindowFocus: false, retry: false,
    refetchInterval: q => {
      const pending = !!(q.state.data as Checks | undefined)?.checks.some(row => row.state === "pending" && row.id.startsWith("provider-"));
      if (!pending) { pendingSince.current = 0; return false; }
      pendingSince.current ||= Date.now();
      return Date.now() - pendingSince.current < 60_000 ? 3000 : false;
    } });
}

const Panel = ({ c, children }: { c: Colors; children: ReactNode }) =>
  <View style={{ ...raised(c), borderRadius: 10, backgroundColor: c.surface1, overflow: "hidden" }}>{children}</View>;

// ---------- 1. what it is ----------

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
  // The row that blocks everything (no provider at all) opens with its fix; optional and note rows fold theirs.
  const [open, setOpen] = useState(row.id === "providers");
  const folds = row.state === "warn" || row.state === "off";
  const color = row.state === "ok" ? c.statusSuccess : row.state === "warn" ? c.statusWarning : row.state === "fail" ? c.statusDanger : c.foregroundMuted;
  return <View accessibilityLabel={`${row.label}: ${row.detail}`} style={{ flexDirection: "row", gap: 10, paddingHorizontal: compact ? 14 : 16, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
    <View style={{ paddingTop: 1 }}>{checking ? <Spinner color={c.foregroundMuted} size={16} /> : <Icon name={GLYPH[row.state]} size={16} color={color} />}</View>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <Text style={t.label}>{row.label}</Text>
      <Text style={t.meta}>{row.detail}</Text>
      {row.fix && folds && !open && <Pressable accessibilityRole="button" accessibilityState={{ expanded: false }} onPress={() => setOpen(true)} style={{ minHeight: compact ? 44 : 28, justifyContent: "center", alignSelf: "flex-start" }}>
        <Text style={[t.meta, { color: c.foreground, textDecorationLine: "underline" }]}>{row.state === "off" ? "How to turn it on" : "How to fix"}</Text>
      </Pressable>}
      {row.fix && (!folds || open) && <View style={{ gap: 6, marginTop: 4 }}>
        <Text style={[t.meta, { color: c.foreground }]}>{row.fix.text}</Text>
        {row.fix.url && <Button theme={theme} compact={compact} kind="ghost" icon="ExternalLink" title="Get the GitHub CLI" accessibilityLabel={`Get the GitHub CLI at ${row.fix.url}`} onPress={() => { void openExternalUrl(row.fix!.url!).catch(() => toast.error("Couldn't open the link here")); }} />}
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
    onSuccess: value => { if (value) cache.setQueryData(followKey, value); void cache.invalidateQueries({ queryKey: ["follow-up", "project-settings"] }); },
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
      <SwitchRow first theme={theme} compact={compact} label="Follow every workspace" hint={list.length ? "New and existing workspaces, except any you turn off below." : "Every workspace, from the first one you create."} value={data?.enable_follow_every ?? null} disabled={change.isPending}
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
    <Panel c={c}><JobRows theme={theme} compact={compact} order={SETUP_ORDER} preselect brief /></Panel>
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
    <TourRow theme={theme} thumb={<ThumbNew c={theme.colors} />} title={NEW_NAME} line="Starts work from an issue, a PR, a link or your words: a workspace and an agent, already briefed." />
    <NewRowChoice theme={theme} compact={compact} />
  </View>;
}

/** The sidebar's Dispatch row (new-row-is-optional): the same switch and tip as Settings → Dispatch. */
function NewRowChoice({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const row = useNewRowSetting();
  return <View style={{ gap: 6, paddingTop: 6 }}>
    <Panel c={c}>
      <SwitchRow first theme={theme} compact={compact} label={NEW_ROW.label} hint={compact ? NEW_ROW.hint(null, null) : NEW_ROW.hint(row.key, isMac() ? "⌘K" : "Ctrl K")} value={row.value} disabled={row.saving} onChange={row.set} />
    </Panel>
    {row.value !== false && <Text style={t.meta}>{NEW_ROW.paseoShort}</Text>}
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
// New: a + row at the top of a sidebar, then the list under it.
const ThumbNew = ({ c }: { c: Colors }) => <><View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}><Icon name="Plus" size={8} color={c.foreground} />{bar(c, "45%", c.foregroundMuted, 4)}</View>{bar(c, "80%")}{bar(c, "65%")}</>;

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
