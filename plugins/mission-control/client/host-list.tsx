import { useSettings, type PluginHostSummary, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { AppModal as Modal } from "./app-modal";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanResponder, Pressable, ScrollView, Text, View, type PanResponderGestureState } from "react-native";
import { missionPreferences } from "../shared/preferences";
import { mergeHostOrder, moveVisibleHost } from "./host-order";
import { CompactLink } from "./compact-link";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Drag = { id: string; index: number; target: number; delta: number; shift: number; pointer: number; startScroll: number; order: string[]; visible: string[] };
const ROW_HEIGHT = 80; // Host name, connection/workspace count, and task count.
const CARD_WIDTH = 176;
const GAP = 4;

export function DragHandle({ label, colors, disabled, horizontal, begin, move, finish, cancel, open }: {
  label: string; disabled: boolean; horizontal: boolean;
  begin: (gesture: PanResponderGestureState) => void; move: (gesture: PanResponderGestureState) => void;
  finish: () => void; cancel: () => void; open: () => void;
} & { colors: Colors }) {
  const latest = useRef({ disabled, horizontal, begin, move, finish, cancel, open });
  latest.current = { disabled, horizontal, begin, move, finish, cancel, open };
  const moved = useRef(false);
  const responder = useMemo(() => PanResponder.create({
    // Capture at the handle before the pointer can leave its narrow bounds.
    onStartShouldSetPanResponderCapture: () => !latest.current.disabled,
    onPanResponderGrant: (_, gesture) => { moved.current = false; latest.current.begin(gesture); },
    onPanResponderMove: (_, gesture) => {
      if (Math.abs(latest.current.horizontal ? gesture.dx : gesture.dy) > 5) moved.current = true;
      latest.current.move(gesture);
    },
    onPanResponderRelease: () => {
      if (moved.current) latest.current.finish();
      else { latest.current.cancel(); latest.current.open(); }
    },
    onPanResponderTerminate: () => latest.current.cancel(),
    onPanResponderTerminationRequest: () => false,
  }), []);
  return <View {...responder.panHandlers} style={{ width: 28, justifyContent: "center" }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Reorder ${label}`} accessibilityHint="Drag to move, or activate for move controls." disabled={disabled} onPress={open} hitSlop={6}
      style={{ minHeight: 44, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.3 : 0.7 }}>
      <Icon name="GripVertical" size={15} color={colors.foregroundMuted} />
    </Pressable>
  </View>;
}

export function HostList({ hosts, visibleHosts, compact, colors, renderHost }: {
  hosts: readonly PluginHostSummary[]; visibleHosts: readonly PluginHostSummary[]; compact: boolean; colors: Colors;
  renderHost: (host: PluginHostSummary) => ReactNode;
}) {
  const settings = useSettings(missionPreferences);
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [dragView, setDragView] = useState<{ id: string; shift: number; target: number } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const scrollFrame = useRef<View>(null);
  const offset = useRef(0);
  const viewport = useRef({ start: 0, length: 0 });
  const drag = useRef<Drag | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const writing = useRef(false);
  const available = new Map(visibleHosts.map(host => [host.serverId, host]));
  const order = mergeHostOrder(pendingOrder ?? (settings.status === "ready" ? settings.values.hostOrder : []), hosts.map(host => host.serverId));
  const orderedHosts = order.flatMap(id => available.has(id) ? [available.get(id)!] : []);
  const visible = orderedHosts.map(host => host.serverId);
  const signature = visible.join("|");
  const step = (compact ? CARD_WIDTH : ROW_HEIGHT) + GAP;
  const enabled = settings.status === "ready" && !settings.saving && !pendingOrder && visible.length > 1;

  function stopDrag() {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    drag.current = null;
    setDragView(null);
  }
  useEffect(() => { stopDrag(); }, [compact, signature, settings.status === "ready" ? settings.revision : null]);
  useEffect(() => () => { if (timer.current !== null) clearInterval(timer.current); }, []);

  async function saveOrder(next: string[]) {
    if (settings.status !== "ready" || writing.current || next.every((id, index) => id === order[index])) return;
    writing.current = true;
    setPendingOrder(next);
    try { await settings.save({ ...settings.values, hostOrder: next }, settings.revision); }
    finally { writing.current = false; setPendingOrder(null); }
  }
  function updateDrag() {
    const current = drag.current;
    if (!current) return;
    current.shift = current.delta + offset.current - current.startScroll;
    current.target = Math.max(0, Math.min(current.visible.length - 1, Math.round(current.index + current.shift / step)));
    setDragView({ id: current.id, shift: current.shift, target: current.target });
  }
  function begin(id: string, gesture: PanResponderGestureState) {
    if (!enabled) return;
    stopDrag();
    const index = visible.indexOf(id);
    drag.current = { id, index, target: index, delta: compact ? gesture.dx : gesture.dy, shift: 0, pointer: compact ? gesture.x0 : gesture.y0, startScroll: offset.current, order, visible };
    scrollFrame.current?.measureInWindow((x, y, width, height) => { viewport.current = { start: compact ? x : y, length: compact ? width : height }; });
    updateDrag();
    timer.current = setInterval(() => {
      const current = drag.current;
      const bounds = viewport.current;
      if (!current || bounds.length === 0) return;
      const direction = current.pointer < bounds.start + 28 ? -1 : current.pointer > bounds.start + bounds.length - 28 ? 1 : 0;
      if (!direction) return;
      const max = Math.max(0, current.visible.length * step - GAP - bounds.length);
      const next = Math.max(0, Math.min(max, offset.current + direction * 12));
      if (next === offset.current) return;
      offset.current = next;
      scroll.current?.scrollTo({ x: compact ? next : 0, y: compact ? 0 : next, animated: false });
      updateDrag();
    }, 40);
  }
  function move(gesture: PanResponderGestureState) {
    if (!drag.current) return;
    drag.current.delta = compact ? gesture.dx : gesture.dy;
    drag.current.pointer = compact ? gesture.moveX : gesture.moveY;
    updateDrag();
  }
  function finish() {
    const current = drag.current;
    stopDrag();
    if (current) void saveOrder(moveVisibleHost(current.order, current.visible, current.id, current.visible[current.target]));
  }
  const movingHost = orderedHosts.find(host => host.serverId === movingId);
  const movingIndex = visible.indexOf(movingId ?? "");
  function moveBy(direction: -1 | 1) {
    if (!movingHost || !enabled) return;
    const target = visible[movingIndex + direction];
    if (target) void saveOrder(moveVisibleHost(order, visible, movingHost.serverId, target));
  }
  const error = settings.saveError ?? ((settings.status === "error" || settings.status === "invalid") ? settings.error : null);

  return <View ref={scrollFrame} style={{ flex: compact ? undefined : 1, minHeight: 0, gap: 6 }}>
    <ScrollView ref={scroll} horizontal={compact} scrollEnabled={!dragView} showsHorizontalScrollIndicator={compact}
      onScroll={event => { offset.current = compact ? event.nativeEvent.contentOffset.x : event.nativeEvent.contentOffset.y; }} scrollEventThrottle={16}
      style={{ flex: compact ? undefined : 1, minHeight: 0 }} contentContainerStyle={{ flexDirection: compact ? "row" : "column", gap: GAP }} nestedScrollEnabled>
      {orderedHosts.map((host, index) => {
        const dragging = dragView?.id === host.serverId;
        const target = dragView && !dragging && dragView.target === index;
        return <View key={host.serverId} style={{ height: ROW_HEIGHT, width: compact ? CARD_WIDTH : undefined, position: "relative", zIndex: dragging ? 10 : 0 }}>
          {target ? <View pointerEvents="none" style={{ position: "absolute", backgroundColor: colors.accent, borderRadius: 2, ...(compact ? { top: 0, bottom: 0, width: 3, ...(index < (drag.current?.index ?? 0) ? { left: -2 } : { right: -2 }) } : { left: 0, right: 0, height: 3, ...(index < (drag.current?.index ?? 0) ? { top: -2 } : { bottom: -2 }) }) }} /> : null}
          <View style={{ flex: 1, flexDirection: "row", borderRadius: 6, backgroundColor: dragging ? colors.surface2 : undefined, opacity: dragging ? 0.85 : 1, transform: dragging ? [compact ? { translateX: dragView.shift } : { translateY: dragView.shift }] : undefined }}>
            {renderHost(host)}
            <DragHandle label={host.label} colors={colors} disabled={!enabled} horizontal={compact} begin={gesture => begin(host.serverId, gesture)} move={move} finish={finish} cancel={stopDrag} open={() => setMovingId(host.serverId)} />
          </View>
        </View>;
      })}
      {visible.length === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No matching hosts.</Text> : null}
    </ScrollView>
    {settings.status === "loading" ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Loading host order…</Text> : null}
    {settings.saving ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 11 }}>Saving order…</Text> : null}
    {error ? <View style={{ gap: 4 }}>
      <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Host order was not saved: {String(error)}</Text>
      <CompactLink label="Reload order" colors={colors} onPress={() => void settings.reload()} />
    </View> : null}
    <Modal colors={colors} title={`Reorder ${movingHost?.label ?? "host"}`} open={!!movingHost} onOpenChange={open => { if (!open) setMovingId(null); }}>
      <Modal.Content>
        <Text style={{ color: colors.foregroundMuted }}>Position {movingIndex + 1} of {visible.length} visible hosts. You can also drag the handle in the host list.</Text>
        <View style={{ flexDirection: "row", gap: 8, paddingTop: 12 }}>
          {([-1, 1] as const).map(direction => <Pressable key={direction} accessibilityRole="button" accessibilityLabel={`Move ${movingHost?.label} ${direction < 0 ? "earlier" : "later"}`} disabled={!enabled || !visible[movingIndex + direction]} onPress={() => moveBy(direction)} style={{ flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 7, opacity: enabled && visible[movingIndex + direction] ? 1 : 0.4 }}>
            <Text style={{ color: colors.foreground }}>{direction < 0 ? "Move earlier" : "Move later"}</Text>
          </Pressable>)}
        </View>
      </Modal.Content>
    </Modal>
  </View>;
}
