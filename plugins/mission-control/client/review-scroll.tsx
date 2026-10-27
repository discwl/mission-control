import { useRef } from "react";
import { FlatList, type FlatListProps } from "react-native";
import { pageMemory } from "./page-memory";

/** Each host/workspace/file/block restores its own diff position after navigation. */
export function ReviewDiffList<T>({ memoryKey, onScroll, onLayout, onContentSizeChange, onScrollBeginDrag, ...props }: FlatListProps<T> & { memoryKey: string }) {
  const ref = useRef<FlatList<T>>(null);
  const offset = useRef(pageMemory.read<number>(memoryKey, 0));
  const restoring = useRef(offset.current > 0);
  const viewport = useRef(0);
  const contentHeight = useRef(0);
  function restore(height: number) {
    if (restoring.current && viewport.current > 0 && height >= offset.current + viewport.current) ref.current?.scrollToOffset({ offset: offset.current, animated: false });
  }
  return <FlatList {...props} ref={ref} contentOffset={{ x: 0, y: offset.current }} scrollEventThrottle={80}
    onLayout={event => { viewport.current = event.nativeEvent.layout.height; restore(contentHeight.current); onLayout?.(event); }}
    onContentSizeChange={(width, height) => { contentHeight.current = height; restore(height); onContentSizeChange?.(width, height); }}
    onScrollBeginDrag={event => { restoring.current = false; onScrollBeginDrag?.(event); }}
    onScroll={event => {
      const next = event.nativeEvent.contentOffset.y;
      if (Math.abs(next - offset.current) < 2) restoring.current = false;
      if (!restoring.current && event.nativeEvent.layoutMeasurement.height > 0) { offset.current = next; pageMemory.write(memoryKey, next); }
      onScroll?.(event);
    }} />;
}
