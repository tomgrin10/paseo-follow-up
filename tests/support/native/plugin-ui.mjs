// @getpaseo/plugin/client/ui under the strict native stand-in (./react-native.mjs).
import { createElement } from "react";
import { View, Text, TextInput as RNTextInput, ScrollView as RNScrollView, Modal as RNModal } from "./react-native.mjs";
export const Icon = props => createElement(View, { accessibilityElementsHidden: true, ...props, children: undefined });
export const ScrollView = RNScrollView;
export const FlatList = ({ data = [], renderItem, ...rest }) => createElement(RNScrollView, rest, data.map((item, index) => createElement(View, { key: index }, renderItem({ item, index }))));
export const TextInput = RNTextInput;
const box = props => createElement(View, null, props.children);
// The host's Modal: a title over its body (Modal.Content).
export const Modal = Object.assign(({ title, open, children }) => open ? createElement(RNModal, { visible: true }, createElement(Text, null, title), children) : null, { Content: box });
export const SettingsAction = box, SettingsCard = box, SettingsRow = box, SettingsSection = box, SettingsSelect = box, SettingsSwitch = box, SidebarRow = box;
export const copyText = async () => {};
export const useToast = () => ({ show() {}, success() {}, error() {}, info() {} });
export { Text };
export const WorkspaceRowBadge = props => createElement(View, { testID: "row-badge", accessibilityLabel: props.accessibilityLabel }, createElement(Text, null, props.label ?? ""));
