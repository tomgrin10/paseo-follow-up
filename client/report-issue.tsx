import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { openExternalUrl, useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { reportLinkRpc, reportSendRpc, reportTargetsRpc } from "../shared/contracts";
import { errorText } from "../shared/errors";
import { BRAND_ICONS } from "./brand-icons";
import { Button, SubmitScope, text } from "./kit";
import { Spinner } from "./motion";
import { tint, type Theme } from "./theme";

/**
 * Report a bug: the small sheet behind Settings → General → Report a bug, ⌘K, /report-issue and every error toast's
 * Report this (docs/report-issue.md). It files nothing itself: it hands the developer's words to an agent, which
 * interviews them, dry-runs follow_report_issue and shows the exact issue before filing it.
 */
export type ReportKind = "bug" | "feature" | "feedback";
export type ReportRequest = { kind?: ReportKind; error?: string | null; at?: number; agentId?: string; workspaceId?: string };

let current: (ReportRequest & { token: number }) | null = null;
let token = 0;
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const l of listeners) l(); };
const hosts: number[] = [];
let hostIds = 0;
let fallback: ((r: ReportRequest) => void) | null = null;

/** Opens the sheet wherever a host is mounted; otherwise asks the plugin to open a surface that has one (Home). */
export function openReportSheet(request: ReportRequest = {}): void {
  current = { ...request, token: ++token };
  if (hosts.length) emit(); else fallback?.(request);
}
/** index.client.tsx: how to reach a host when none is mounted (open Home, which mounts one and reads the request). */
export function setReportFallback(open: ((r: ReportRequest) => void) | null) { fallback = open; }
/** Test seam. */
export const reportRequestNow = () => current;
const close = () => { current = null; emit(); };

const KINDS: { id: ReportKind; label: string; icon: string; placeholder: string }[] = [
  { id: "bug", label: "Bug", icon: "Bug", placeholder: "What went wrong, and what did you expect?" },
  { id: "feature", label: "Idea", icon: "Lightbulb", placeholder: "What would you like Follow-up to do?" },
  { id: "feedback", label: "Feedback", icon: "MessageCircle", placeholder: "What's working, what isn't?" },
];
export const TRUST_LINE = "The agent gathers versions and recent errors, removes private names, and shows you the issue before filing it. Nothing is posted without your yes.";

type Target = { id: string; title: string; provider: string; status: string; workspaceId: string | null; workspaceTitle: string | null; main: boolean };
const NEW = "new";

/** "Billing retries · main agent", "Claude Code · idle". */
export function targetLines(t: Target): [string, string] {
  const provider = t.provider === "claude" ? "Claude Code" : t.provider === "codex" ? "Codex" : t.provider;
  const head = t.workspaceTitle ? `${t.workspaceTitle} · ${t.main ? "main agent" : t.title}` : t.title;
  return [head, `${provider} · ${t.status === "running" ? "working" : t.status}`];
}

function ProviderMark({ provider, theme }: { provider: string | null; theme: Theme }) {
  const c = theme.colors;
  return <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
    {provider === "claude" ? <Icon icon={BRAND_ICONS.claude} size={13} color={c.foregroundMuted} />
      : provider === null ? <Icon name="Plus" size={13} color={c.foregroundMuted} />
      : <Icon name={provider === "codex" ? "SquareTerminal" : "Bot"} size={13} color={c.foregroundMuted} />}
  </View>;
}

function Segmented({ value, onChange, theme, compact }: { value: ReportKind; onChange: (k: ReportKind) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  return <View accessibilityRole="radiogroup" accessibilityLabel="Kind" style={{ flexDirection: "row", backgroundColor: c.surface2, borderRadius: 8, padding: 2, gap: 2 }}>
    {KINDS.map(k => {
      const on = k.id === value;
      return <Pressable key={k.id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(k.id)}
        style={state => ({ flex: 1, minHeight: compact ? 40 : 28, borderRadius: 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
          backgroundColor: on ? c.surface0 : (state as { hovered?: boolean }).hovered ? tint(c.foreground, c) : "transparent", ...(on ? { boxShadow: "0px 0px 0px 1px rgba(127,127,127,0.18)" } : {}) })}>
        <Icon name={k.icon} size={14} color={on ? c.foreground : c.foregroundMuted} />
        <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: compact ? 14 : 13, fontWeight: "500" }}>{k.label}</Text>
      </Pressable>;
    })}
  </View>;
}

type Phase = { kind: "edit" } | { kind: "sending" } | { kind: "sent"; agentId: string; title: string; started: boolean } | { kind: "failed"; message: string };

export function ReportSheet({ request, theme, layout, openAgent, onClose }: { request: ReportRequest; theme: Theme; layout: PluginHostProps["layout"]; openAgent?: (agentId: string) => void; onClose: () => void }) {
  const c = theme.colors; const compact = layout.compact; const t = text(c, compact);
  const [kind, setKind] = useState<ReportKind>(request.kind ?? "bug");
  const [words, setWords] = useState("");
  const [error, setError] = useState<string | null>(request.error ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [targets, setTargets] = useState<{ agents: Target[]; defaultId: string | null; newAgentWorkspace: { id: string; title: string } | null } | null>(null);
  const readTargets = useRpc(reportTargetsRpc); const send = useRpc(reportSendRpc); const link = useRpc(reportLinkRpc);
  useEffect(() => {
    let live = true;
    readTargets({ workspaceId: request.workspaceId, agentId: request.agentId }).then(r => { if (live) setTargets(r); }).catch(() => { if (live) setTargets({ agents: [], defaultId: null, newAgentWorkspace: null }); });
    return () => { live = false; };
  }, [request.workspaceId, request.agentId]);
  const chosen = picked ?? targets?.defaultId ?? (targets?.newAgentWorkspace ? NEW : null);
  const target = targets?.agents.find(a => a.id === chosen) ?? null;
  const nowhere = !!targets && !targets.agents.length && !targets.newAgentWorkspace;
  const empty = !words.trim() && !error;
  const placeholder = error ? "Anything else? What were you doing when it happened?" : KINDS.find(k => k.id === kind)!.placeholder;
  const submit = async () => {
    if (empty || phase.kind === "sending" || !chosen) return;
    setPhase({ kind: "sending" });
    try {
      const r = await send({ kind, text: words, error, ...(chosen === NEW ? { newAgentWorkspaceId: targets!.newAgentWorkspace!.id } : { agentId: chosen }) });
      setPhase({ kind: "sent", ...r });
    } catch (e) { setPhase({ kind: "failed", message: errorText(e) }); }
  };
  const openGithub = async () => { try { const { url } = await link({ kind, text: [words, error ? `Error: ${error}` : ""].filter(Boolean).join("\n\n") }); await openExternalUrl(url); onClose(); } catch (e) { setPhase({ kind: "failed", message: errorText(e) }); } };
  const pad = compact ? 16 : 16;
  const row = (id: string, lines: [string, string], provider: string | null, selected: boolean, onPress: () => void, first: boolean) =>
    <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 8, minHeight: compact ? 48 : 0, borderTopWidth: first ? 0 : 1, borderTopColor: c.border, backgroundColor: selected || (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
      <ProviderMark provider={provider} theme={theme} />
      <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={t.body}>{lines[0]}</Text><Text numberOfLines={1} style={t.meta}>{lines[1]}</Text></View>
    </Pressable>;
  const newLines: [string, string] = ["A new agent", `Starts in ${targets?.newAgentWorkspace?.title ?? "this workspace"}, with the default model`];

  if (phase.kind === "sent") return <>
    <Modal.Content contentContainerStyle={{ padding: pad, gap: 12 }}>
      <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 10, padding: 12, borderRadius: 8, backgroundColor: tint(c.statusSuccess, c) }}>
        <Icon name="CircleCheck" size={16} color={c.statusSuccess} />
        <View style={{ flex: 1 }}>
          <Text style={t.label}>{phase.started ? `Started ${phase.title}` : `Sent to ${phase.title}`}</Text>
          <Text style={t.body}>It'll ask you anything it needs in that chat, then show you the issue before filing it.</Text>
        </View>
      </View>
    </Modal.Content>
    <Footer compact={compact} theme={theme}>
      <Button title="Close" kind="ghost" theme={theme} compact={compact} grow={compact} onPress={onClose} />
      {openAgent && <Button title="Open the chat" kind="primary" theme={theme} compact={compact} grow={compact} onPress={() => { openAgent(phase.agentId); onClose(); }} />}
    </Footer>
  </>;

  return <SubmitScope enabled={!empty && !!chosen && phase.kind !== "sending"} onSubmit={() => void submit()}>
    <Modal.Content contentContainerStyle={{ padding: pad, gap: 12, opacity: phase.kind === "sending" ? 0.7 : 1 }}>
      <Segmented value={kind} onChange={setKind} theme={theme} compact={compact} />
      {error && <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", backgroundColor: c.surface2, borderRadius: 8, padding: 10 }}>
        <Icon name="CircleAlert" size={16} color={c.statusDanger} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={t.meta}>From the error you saw{request.at ? ` · ${new Date(request.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</Text>
          <Text selectable style={{ color: c.foreground, fontSize: 12, lineHeight: 17, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" }) }}>{error}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Remove the error" hitSlop={8} onPress={() => setError(null)}><Icon name="X" size={14} color={c.foregroundMuted} /></Pressable>
      </View>}
      <TextInput value={words} onChangeText={setWords} multiline autoFocus placeholder={placeholder} placeholderTextColor={c.foregroundMuted} accessibilityLabel="Describe it"
        style={{ minHeight: compact ? 132 : 112, borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface0, paddingHorizontal: 12, paddingVertical: 10, color: c.foreground, fontSize: compact ? 14 : 13, lineHeight: compact ? 20 : 18, textAlignVertical: "top" }} />
      {nowhere ? <View style={{ flexDirection: "row", gap: 10, padding: 12, borderRadius: 8, backgroundColor: c.surface2 }}>
        <Icon name="Info" size={14} color={c.foregroundMuted} />
        <View style={{ flex: 1 }}><Text style={t.label}>No workspace to start an agent in</Text><Text style={t.meta}>Open a project in Paseo and try again, or file it yourself on GitHub. Your text goes into the new issue.</Text></View>
      </View> : <View>
        <Text style={[t.meta, { marginBottom: 6 }]}>Send to</Text>
        {!targets ? <View style={{ minHeight: 46, justifyContent: "center", paddingHorizontal: 10, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}><Spinner color={c.foregroundMuted} size={14} label="Loading agents" /></View>
          : <Pressable accessibilityRole="button" accessibilityLabel="Send to" accessibilityHint="Pick which agent gets this" onPress={() => setChoosing(v => !v)}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, minHeight: compact ? 48 : 0, backgroundColor: c.surface0 }}>
            <ProviderMark provider={target ? target.provider : null} theme={theme} />
            <View style={{ flex: 1, minWidth: 0 }}>{(target ? targetLines(target) : newLines).map((l, i) => <Text key={i} numberOfLines={1} style={i ? t.meta : t.body}>{l}</Text>)}</View>
            <Icon name="ChevronsUpDown" size={14} color={c.foregroundMuted} />
          </Pressable>}
        {choosing && targets && <View style={{ marginTop: 6, borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden", backgroundColor: c.surface0 }}>
          {targets.agents.map((a, i) => row(a.id, targetLines(a), a.provider, a.id === chosen, () => { setPicked(a.id); setChoosing(false); }, i === 0))}
          {targets.newAgentWorkspace && row(NEW, newLines, null, chosen === NEW, () => { setPicked(NEW); setChoosing(false); }, !targets.agents.length)}
        </View>}
      </View>}
      {!nowhere && <View style={{ flexDirection: "row", gap: 8 }}>
        <Icon name="ShieldCheck" size={14} color={c.foregroundMuted} />
        <Text style={[t.meta, { flex: 1 }]}>{TRUST_LINE}</Text>
      </View>}
      {phase.kind === "failed" && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 12, lineHeight: 17 }}>Not sent: {phase.message}</Text>}
    </Modal.Content>
    <Footer compact={compact} theme={theme}>
      <Button title="Cancel" kind="ghost" theme={theme} compact={compact} grow={compact} onPress={onClose} />
      {nowhere ? <Button title="Open on GitHub" icon="ExternalLink" kind="primary" theme={theme} compact={compact} grow={compact} disabled={empty} onPress={() => void openGithub()} />
        : <Button title={chosen === NEW ? "Start agent and send" : "Send to agent"} kind="primary" theme={theme} compact={compact} grow={compact} shortcut disabled={empty || !chosen} loading={phase.kind === "sending"} onPress={() => void submit()} />}
    </Footer>
  </SubmitScope>;
}

function Footer({ children, compact, theme }: { children: React.ReactNode; compact: boolean; theme: Theme }) {
  return <View style={compact
    ? { flexDirection: "column-reverse", gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }
    : { flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: theme.colors.border }}>{children}</View>;
}

/** Mount once per surface (Home, the panel, Settings): the first one mounted shows the sheet while a request is open. */
export function ReportSheetHost({ theme, layout, openAgent }: { theme: Theme; layout: PluginHostProps["layout"]; openAgent?: (agentId: string) => void }) {
  const [id] = useState(() => ++hostIds);
  useEffect(() => { hosts.push(id); emit(); return () => { hosts.splice(hosts.indexOf(id), 1); emit(); }; }, [id]);
  // The snapshot is a version, so a host mounting or leaving re-renders the others too (who owns the sheet changes).
  useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version, () => version);
  const request = current;
  if (!request || hosts[0] !== id) return null;
  return <Modal title="Report an issue" open onOpenChange={next => { if (!next) close(); }}>
    <ReportSheet key={request.token} request={request} theme={theme} layout={layout} openAgent={openAgent} onClose={close} />
  </Modal>;
}
