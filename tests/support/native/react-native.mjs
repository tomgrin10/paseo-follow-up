// A strict stand-in for React Native as the phone app runs it (tests/native-render.test.ts,
// client-renders-under-native-rules): no DOM, Platform.OS "android", and a host view throws where React Native
// on a phone does: a raw string or number outside <Text> ("Text strings must be rendered within a <Text> component"),
// and an accessibilityRole Android's view manager rejects (AccessibilityRole.fromValue,
// ReactAccessibilityDelegate.java; read from react-native's own source).
import { createElement, Children, Fragment, forwardRef } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const rnRoot = dirname(createRequire(import.meta.url).resolve("react-native/package.json"));
const java = readFileSync(join(rnRoot, "ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.java"), "utf8");
const body = java.slice(java.indexOf("public enum AccessibilityRole"));
export const ANDROID_ROLES = new Set(body.slice(body.indexOf("{") + 1, body.indexOf(";")).split(",").map(x => x.trim().toLowerCase()).filter(Boolean));

function checkRole(props) {
  const role = props?.accessibilityRole;
  if (role != null && !ANDROID_ROLES.has(String(role).toLowerCase())) throw new Error(`Invalid accessibility role value: ${role}`);
}
function checkText(children, name) {
  const walk = c => {
    if (typeof c === "string" || typeof c === "number") throw new Error(`Text strings must be rendered within a <Text> component (in <${name}>: ${JSON.stringify(c)})`);
    if (c && c.type === Fragment) Children.forEach(c.props.children, walk);
  };
  Children.forEach(children, walk);
}
const host = (name, { text = false } = {}) => {
  const C = forwardRef((props, ref) => {
    checkRole(props);
    let children = props.children;
    if (typeof children === "function") children = children({ pressed: false, hovered: false, focused: false });
    if (!text) checkText(children, name);
    return createElement(name, { ...props, ref, children });
  });
  C.displayName = name;
  return C;
};

export const View = host("View");
export const Text = host("Text", { text: true });
export const TextInput = host("TextInput", { text: true });
export const Pressable = host("Pressable");
export const ScrollView = host("ScrollView");
export const Image = host("Image");
export const ActivityIndicator = host("ActivityIndicator");
export const Modal = host("Modal");
export const Platform = { OS: "android", Version: 34, select: o => ("android" in o ? o.android : "native" in o ? o.native : o.default) };
class Value { constructor(v) { this.v = v; } setValue(v) { this.v = v; } interpolate() { return this; } addListener() { return ""; } removeListener() {} stopAnimation() {} }
const anim = () => ({ start: cb => cb?.({ finished: true }), stop() {}, reset() {} });
export const Animated = { View: host("AnimatedView"), Text: host("AnimatedText", { text: true }), ScrollView: host("AnimatedScrollView"), Value, timing: anim, spring: anim, sequence: anim, parallel: anim, loop: anim, delay: anim, event: () => () => {} };
export const Easing = new Proxy({}, { get: () => (..._a) => (t => t) });
export const PanResponder = { create: () => ({ panHandlers: {} }) };
const sub = { remove() {} };
export const AccessibilityInfo = { isReduceMotionEnabled: async () => false, isScreenReaderEnabled: async () => false, addEventListener: () => sub, announceForAccessibility() {} };
export const Keyboard = { addListener: () => sub, dismiss() {}, isVisible: () => false, metrics: () => undefined };
export const AppState = { currentState: "active", addEventListener: () => sub };
export const AppRegistry = { registerComponent() {} };
// The system font size (Android Settings → Display → Font size): a test sets globalThis.__nativeFontScale.
const fontScale = () => globalThis.__nativeFontScale ?? 1;
export const Dimensions = { get: () => ({ width: 390, height: 844, scale: 3, fontScale: fontScale() }), addEventListener: () => sub };
export const useWindowDimensions = () => ({ width: 390, height: 844, scale: 3, fontScale: fontScale() });
export const findNodeHandle = () => null;
export const StyleSheet = { create: s => s, flatten: s => (Array.isArray(s) ? Object.assign({}, ...s.flat(Infinity).filter(Boolean)) : s ?? {}), hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} };
