import { Dimensions } from "react-native";
import { compactWidth, type Layout } from "./layout";

/**
 * The app window's layout, decided as Paseo decides it: compact when narrower than its md breakpoint. For code
 * outside a panel or screen (buttons, slash commands, Command Center items); those get Paseo's own `layout` prop.
 */
export const windowLayout: Layout = {
  compact: () => Dimensions.get("window").width < compactWidth,
  subscribe(listener) {
    const subscription = Dimensions.addEventListener("change", listener) as { remove?(): void } | undefined;
    return () => subscription?.remove?.();
  },
};
