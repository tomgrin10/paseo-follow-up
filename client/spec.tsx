import { useEffect, useState } from "react";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { workspaceSpecRpc } from "../shared/contracts";
import type { ListWorkspace as Workspace } from "../shared/list";
import { specLabel, validSpecUrl } from "../shared/spec";
import { ago } from "../shared/attention";
import { Button, CardRow, text, type Theme, SubmitScope } from "./kit";
import { overviewKey, workspaceKey } from "./keys";
import { runAction } from "./toasts";

const openUrl = (url: string) => { void openExternalUrl(url).catch(() => undefined); };

export function specSource(w: Workspace): string {
  const s = w.spec;
  if (!s) return "";
  if (s.source === "developer") return "Set by you";
  if (s.source === "agent") return "Registered by the main agent";
  return s.by && s.by !== w.mainAgentId ? "Published from a root session" : "Published by the main agent";
}

/** The header link to the workspace's spec. Calm: a quiet chip that opens the page in the browser. */
export function SpecChip({ workspace: w, theme, compact }: { workspace: Pick<Workspace, "spec">; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  const url = w.spec?.url;
  if (!url) return null;
  const label = specLabel(w.spec!);
  return <Pressable accessibilityRole="link" accessibilityLabel={`Open the spec: ${label}`} onPress={() => openUrl(url)} hitSlop={compact ? 0 : 6}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 5, minHeight: compact ? 36 : 24, paddingHorizontal: compact ? 10 : 8, borderRadius: 999, borderWidth: 1, borderColor: c.border,
      backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <Icon name="FileText" size={compact ? 14 : 12} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Spec</Text>
    <Icon name="ArrowUpRight" size={compact ? 13 : 11} color={c.foregroundMuted} />
  </Pressable>;
}

/** The spec row in the workspace fold: what the link is, where it came from, and Edit. */
export function SpecRow({ workspace: w, theme, compact, onEdit }: { workspace: Workspace; theme: Theme; compact: boolean; onEdit: () => void }) {
  const c = theme.colors; const t = text(c);
  const url = w.spec?.url;
  const others = w.artifacts.filter(a => a.url !== url).length;
  return <CardRow theme={theme} compact={compact}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
        <Text style={t.label}>Spec</Text>
        <Text numberOfLines={2} style={t.meta}>{url
          ? `${specLabel(w.spec!)} · ${specSource(w)}${others ? ` · ${others} other artifact${others === 1 ? "" : "s"}` : ""}`
          : w.spec?.source === "developer" ? "You removed the link. Agents can't set it until you add one or hand it back."
          : "No link yet. The main agent registers its spec artifact, or add one."}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {url && <Button theme={theme} compact={compact} icon="ArrowUpRight" title="Open" accessibilityLabel="Open the spec" onPress={() => openUrl(url)} />}
        <Button theme={theme} compact={compact} kind={url ? "ghost" : "secondary"} icon={url ? "Pencil" : "Link"} title={url ? "Edit" : "Add link"} accessibilityLabel={url ? "Edit the spec link" : "Add a spec link"} onPress={onEdit} />
      </View>
    </View>
  </CardRow>;
}

/** Set, change or remove the spec link, or pick one of the workspace's other artifacts. */
export function SpecSheet({ workspace: w, open, theme, compact, onClose }: { workspace: Workspace; open: boolean; theme: Theme; compact: boolean; onClose: () => void }) {
  const c = theme.colors; const t = text(c);
  const toast = useToast(); const cache = useQueryClient();
  const save = useRpc(workspaceSpecRpc);
  const [url, setUrl] = useState(w.spec?.url ?? "");
  const [title, setTitle] = useState(w.spec?.title ?? "");
  useEffect(() => { if (open) { setUrl(w.spec?.url ?? ""); setTitle(w.spec?.title ?? ""); } }, [open]);
  // Quick action: the sheet closes at once and a toast reports the outcome (Retry on failure).
  const act = (input: { action: "set"; url: string; title?: string | null } | { action: "remove" } | { action: "reset" }) => {
    onClose();
    void runAction({
      label: "Spec link", toast, run: () => save({ workspaceId: w.id, ...input }),
      success: () => ({ message: input.action === "set" ? "Spec link saved" : input.action === "remove" ? "Spec link removed" : "Spec link handed back to the agent" }),
      onSuccess: () => {
        void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey });
        // The spec is a linked item too (derived in the view), so the Linked sheet re-reads.
        void cache.invalidateQueries({ queryKey: ["follow-up", "linked", w.id] });
      },
      failure: input.action === "set" ? "Spec link not saved" : "Spec link not changed",
    });
  };
  const valid = validSpecUrl(url);
  const others = w.artifacts.filter(a => a.url !== w.spec?.url);
  const field = { minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface1, fontSize: 13 };
  return <Modal title="Spec link" icon={<Icon name="FileText" size={18} color={c.foregroundMuted} />} open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20 }}>
      <SubmitScope enabled={!!valid} onSubmit={() => act({ action: "set", url, title: title.trim() || null })} style={{ gap: 14 }}>
      <Text style={t.meta}>The page that sums up this workspace, usually the Claude artifact the main agent keeps up to date. It shows as Spec in Follow-up's header.</Text>
      {w.spec?.url && <Text style={t.small}>{specSource(w)} {ago(w.spec.at)}</Text>}
      <View style={{ gap: 6 }}>
        <Text style={t.label}>Link</Text>
        <TextInput accessibilityLabel="Spec link" placeholder="https://claude.ai/code/artifact/…" placeholderTextColor={c.foregroundMuted} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} inputMode="url"
          style={[field, url && !valid ? { borderColor: c.statusDanger } : null]} />
        {!!url && !valid && <Text style={[t.small, { color: c.statusDanger }]}>Use a full https:// link.</Text>}
      </View>
      <View style={{ gap: 6 }}>
        <Text style={t.label}>Name <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>(optional)</Text></Text>
        <TextInput accessibilityLabel="Spec name, optional" placeholder="Invoice retry spec" placeholderTextColor={c.foregroundMuted} value={title} onChangeText={setTitle} maxLength={120} style={field} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button shortcut theme={theme} compact={compact} kind="primary" icon="Check" title="Save" disabled={!valid} onPress={() => act({ action: "set", url, title: title.trim() || null })} />
        {w.spec?.url && <Button theme={theme} compact={compact} kind="danger" title="Remove link" onPress={() => act({ action: "remove" })} />}
        {w.spec?.source === "developer" && <Button theme={theme} compact={compact} kind="ghost" icon="Undo2" title="Let the agent set it" accessibilityLabel="Hand the spec link back to the main agent and detection" onPress={() => act({ action: "reset" })} />}
      </View>
      {others.length > 0 && <View style={{ gap: 6, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border }}>
        <Text style={t.label}>Other artifacts from this workspace</Text>
        {others.map(a => <View key={a.url} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="FileText" size={13} color={c.foregroundMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={t.body}>{a.title ?? "Untitled artifact"}</Text>
            <Text numberOfLines={1} style={t.small}>{a.publishes > 1 ? `Published ${a.publishes} times` : "Published once"}{a.lastAt ? ` · ${ago(a.lastAt)}` : ""}</Text>
          </View>
          <Button theme={theme} compact={compact} kind="ghost" icon="ArrowUpRight" title="Open" accessibilityLabel={`Open ${a.title ?? "artifact"}`} onPress={() => openUrl(a.url)} />
          <Button theme={theme} compact={compact} title="Use" accessibilityLabel={`Use ${a.title ?? "this artifact"} as the spec`} onPress={() => act({ action: "set", url: a.url, title: a.title })} />
        </View>)}
      </View>}
      </SubmitScope>
    </Modal.Content>
  </Modal>;
}
