import { Modal as SdkModal, type ModalProps, type ModalContentProps } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Children, Fragment, createContext, isValidElement, useContext, type ReactNode } from "react";
import { Modal as NativeModal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { CompactLink } from "./compact-link";

type Colors = PluginSurfaceProps["theme"]["colors"];
export type AppModalProps = ModalProps & { colors: Colors; maxWidth?: number; maxHeight?: number };
const Presentation = createContext<{ adaptive: boolean } | null>(null);
function boundedContent(children: ReactNode): boolean {
  return Children.toArray(children).some(child => {
    if (!isValidElement<{ scrollable?: boolean; children?: ReactNode }>(child)) return false;
    return child.type === AppModalContent ? child.props.scrollable === false : child.type === Fragment && boundedContent(child.props.children);
  });
}
function AppModalRoot({ colors, maxWidth = 900, maxHeight, ...props }: AppModalProps) {
  const { width, height } = useWindowDimensions();
  const adaptive = Platform.OS !== "web" || width < 768;
  if (adaptive) return <Presentation.Provider value={{ adaptive }}><SdkModal {...props} /></Presentation.Provider>;
  const padding = 24;
  const availableHeight = Math.max(0, height - padding * 2);
  const cardHeight = Math.min(height * 0.85, availableHeight, maxHeight ?? Infinity);
  const close = () => props.onOpenChange(false);
  return <Presentation.Provider value={{ adaptive }}>
    <NativeModal transparent visible={props.open} animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding, backgroundColor: "rgba(0,0,0,0.5)" }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Dismiss ${props.title}`} onPress={close} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }} />
        <View accessibilityLabel={props.title} accessibilityViewIsModal style={{ width: "100%", maxWidth: Math.max(0, Math.min(maxWidth, width - padding * 2)), maxHeight: cardHeight, height: boundedContent(props.children) ? cardHeight : undefined, flexShrink: 1, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, flexShrink: 0 }}>
            {props.icon}
            <Text accessibilityRole="header" style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{props.title}</Text>
            <CompactLink iconOnly label={`Close ${props.title}`} icon="X" colors={colors} onPress={close} />
          </View>
          {props.children}
        </View>
      </View>
    </NativeModal>
  </Presentation.Provider>;
}
function AppModalContent({ children, style, contentContainerStyle, scrollable = true }: ModalContentProps) {
  const presentation = useContext(Presentation);
  if (!presentation) throw new Error("AppModal.Content must be inside AppModal");
  if (presentation.adaptive) return <SdkModal.Content style={style} contentContainerStyle={contentContainerStyle} scrollable={scrollable}>{children}</SdkModal.Content>;
  if (!scrollable) return <View style={[{ flex: 1, minHeight: 0 }, style]}><View style={[{ flex: 1, minHeight: 0, padding: 24, gap: 16 }, contentContainerStyle]}>{children}</View></View>;
  return <ScrollView keyboardShouldPersistTaps="handled" style={[{ minHeight: 0, flexShrink: 1, flexGrow: 0 }, style]} contentContainerStyle={[{ padding: 24, gap: 16 }, contentContainerStyle]}>{children}</ScrollView>;
}
function AppModalActions({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", flexShrink: 0 }, style]}>{children}</View>;
}
export const AppModal = Object.assign(AppModalRoot, { Content: AppModalContent, Actions: AppModalActions });
