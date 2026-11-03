import type { ComponentType } from "react";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, View } from "react-native";

/** Keep settings outside the scrolling workspace content and its primary controls. */
export function withSettingsFooter<P extends PluginSurfaceProps>(Component: ComponentType<P>, client: PluginClientContext) {
  return function PluginView(props: P) {
    const size = props.layout.compact ? 44 : 36;
    return <View style={{ flex: 1, minHeight: 0, backgroundColor: props.theme.colors.surface0 }}>
      <View style={{ flex: 1, minHeight: 0 }}><Component {...props} /></View>
      <View style={{ flexShrink: 0, alignItems: "flex-end", paddingHorizontal: 8, paddingVertical: 4, borderTopWidth: 1, borderColor: props.theme.colors.border }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Follow-up settings"
          accessibilityHint="Open Follow-up project settings"
          onPress={() => client.openSettings("projects")}
          style={({ pressed }) => ({ width: size, height: size, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: pressed ? props.theme.colors.surface2 : "transparent" })}
        ><Icon name="Settings" size={16} color={props.theme.colors.foregroundMuted} /></Pressable>
      </View>
    </View>;
  };
}
