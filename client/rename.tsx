import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { renameStatusRpc, renameWorkspaceRpc } from "../shared/contracts";
import { checkName, NAME_MAX_CHARS, type RenameStatus } from "../shared/rename";
import { ago } from "../shared/attention";
import { errorText } from "../shared/errors";
import { Button, SubmitScope, text, type Theme } from "./kit";
import { overviewKey } from "./keys";
import { Spinner } from "./motion";
import { hasToastHost, pushToast, runAction } from "./toast-store";

/**
 * Rename with AI (docs/ai-roles.md#rename-with-ai): one dialog for every entry point (row menus, the panel's More
 * menu, ⌘K). It asks for a suggestion as it opens, shows it in an editable field, and renames only on Rename. The
 * toast after it carries Undo; for 24 hours the dialog also offers Undo last rename.
 */

export type RenameRequest = { workspaceId: string; title?: string | null };
let current: (RenameRequest & { token: number }) | null = null;
let token = 0;
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const l of listeners) l(); };
const hosts: number[] = [];
let hostIds = 0;

/** Opens the dialog in the first mounted host (Home, the panel, the sidebar view, Settings). */
export function openRename(request: RenameRequest): void { current = { ...request, token: ++token }; emit(); }
const close = () => { current = null; emit(); };
/** Test seam. */
export const renameRequestNow = () => current;

export function RenameHost({ theme, compact }: { theme: Theme; compact: boolean }) {
  const [id] = useState(() => ++hostIds);
  useEffect(() => { hosts.push(id); emit(); return () => { hosts.splice(hosts.indexOf(id), 1); emit(); }; }, [id]);
  useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version, () => version);
  const request = current;
  if (!request || hosts[0] !== id) return null;
  return <RenameDialog key={request.token} request={request} theme={theme} compact={compact} onClose={close} />;
}

/** Shown after a rename: what it's called now, with Undo for 10 s (held while the pointer or focus is on it). */
export const RENAME_UNDO_MS = 10_000;

type Phase = "suggesting" | "ready" | "error";

export function RenameDialog({ request, theme, compact, onClose }: { request: RenameRequest; theme: Theme; compact: boolean; onClose: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const status = useRpc(renameStatusRpc); const rename = useRpc(renameWorkspaceRpc);
  const toast = useToast(); const cache = useQueryClient();
  const [info, setInfo] = useState<RenameStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("suggesting");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const run = useRef(0);

  const suggest = useCallback(async () => {
    const mine = ++run.current;
    setPhase("suggesting"); setError(null);
    // The quick read first (the name now, the Undo link), so the dialog is never blank while the model runs.
    status({ workspaceId: request.workspaceId }).then(s => { if (mine === run.current) setInfo(prev => prev ?? s); }).catch(() => undefined);
    try {
      const s = await status({ workspaceId: request.workspaceId, suggest: true });
      if (mine !== run.current) return;
      setInfo(s); setName(s.suggestion ?? ""); setEdited(false); setPhase("ready");
    } catch (e) {
      if (mine !== run.current) return;
      setError(errorText(e).replace(/^Couldn't suggest a (usable )?name[:.]?\s*/i, "").replace(/\s*Try again, or type one\.?$/i, "") || null); setPhase("error");
    }
  }, [request.workspaceId, status]);
  useEffect(() => { void suggest(); return () => { run.current++; }; }, [suggest]);

  const now = info?.current ?? request.title ?? "";
  const check = checkName(name, { keys: info?.keys ?? [], current: now || null });
  const canRename = phase !== "suggesting" && check.ok;
  const refresh = () => { void cache.invalidateQueries({ queryKey: overviewKey }); void cache.invalidateQueries({ queryKey: ["follow-up"] }); };

  const undo = (workspaceId: string) => void runAction({ label: "Undo rename", toast, run: () => rename({ workspaceId, undo: true }),
    success: r => `Name back to ${r.title}`, onSuccess: refresh, failure: "Couldn't undo the rename" }, `rename:${workspaceId}`);

  const apply = () => {
    if (!check.ok) return;
    const title = check.name; const workspaceId = request.workspaceId;
    onClose();
    void runAction({ label: "Rename", toast, run: () => rename({ workspaceId, title }), onSuccess: refresh, failure: "Couldn't rename the workspace",
      success: r => {
        if (!hasToastHost()) return `Renamed to ${r.title}`;
        pushToast("success", `Renamed to ${r.title}`, [{ label: "Undo", onPress: () => undo(workspaceId) }], { durationMs: RENAME_UNDO_MS, keep: true });
        return null;
      } }, `rename:${workspaceId}`);
  };

  const field = { minHeight: compact ? 44 : 34, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, color: c.foreground, backgroundColor: c.surface1, fontSize: compact ? 16 : 14,
    borderColor: edited && !check.ok ? c.statusDanger : c.border };
  const counter = name.trim().length;
  return <Modal title="Rename with AI" icon={<Icon name="Sparkles" size={18} color={c.foregroundMuted} />} open onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20 }}>
      <SubmitScope enabled={canRename} onSubmit={apply} style={{ gap: compact ? 16 : 14, maxWidth: 520 }}>
        <View style={{ gap: 2 }}>
          <Text style={t.small}>Now</Text>
          <Text numberOfLines={2} style={t.body}>{now || "…"}</Text>
        </View>
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <Text style={t.label}>New name</Text>
            {phase !== "suggesting" && <Text style={[t.small, { fontVariant: ["tabular-nums"] }, counter > NAME_MAX_CHARS ? { color: c.statusDanger } : null]}>{counter}/{NAME_MAX_CHARS}</Text>}
          </View>
          <View>
            <TextInput accessibilityLabel="New name" value={phase === "suggesting" ? "" : name} editable={phase !== "suggesting"} autoFocus={!compact} selectTextOnFocus
              placeholder={phase === "suggesting" ? "" : "Type a name"} placeholderTextColor={c.foregroundMuted}
              onChangeText={v => { setName(v); setEdited(true); }} autoCapitalize="sentences" maxLength={NAME_MAX_CHARS + 20} style={[field, phase === "suggesting" ? { opacity: 0.6 } : null]} />
            {phase === "suggesting" && <View pointerEvents="none" accessibilityLiveRegion="polite" style={{ position: "absolute", left: 10, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Spinner color={c.foregroundMuted} size={12} />
              <Text style={[t.meta, { color: c.foregroundMuted }]}>Suggesting a name…</Text>
            </View>}
          </View>
          {phase === "error" && <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 6 }}>
            <View style={{ paddingTop: 2 }}><Icon name="TriangleAlert" size={13} color={c.statusWarning} /></View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[t.meta, { color: c.statusWarning }]}>Couldn't suggest a name. Type one, or try again.</Text>
              {!!error && <Text style={t.small}>{error}</Text>}
            </View>
          </View>}
          {phase === "ready" && edited && !check.ok && <Text accessibilityLiveRegion="polite" style={[t.small, { color: c.statusDanger }]}>{check.reason}</Text>}
          {phase === "ready" && !edited && <Text style={t.small}>From the Summary, PRs and linked items. Edit it if it's not quite right.</Text>}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Button shortcut theme={theme} compact={compact} kind="primary" icon="Check" title="Rename" disabled={!canRename} onPress={apply} />
          <Button theme={theme} compact={compact} kind="ghost" icon="RefreshCw" title={phase === "error" ? "Try again" : "Suggest another"} disabled={phase === "suggesting"} onPress={() => void suggest()} />
        </View>
        {info?.last && <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: compact ? 12 : 10, flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={[t.small, { flex: 1, minWidth: 160 }]} numberOfLines={2}>Renamed from {info.last.from} {ago(info.last.at)}</Text>
          <Button theme={theme} compact={compact} kind="ghost" icon="Undo2" title="Undo last rename" onPress={() => { onClose(); undo(request.workspaceId); }} />
        </View>}
      </SubmitScope>
    </Modal.Content>
  </Modal>;
}
