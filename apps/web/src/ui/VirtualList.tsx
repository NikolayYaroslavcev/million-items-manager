import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from 'react';

export const ROW_HEIGHT = 44;
const NEAR_END = 10;

export interface VirtualListHandle {
  scrollToIndex(index: number): void;
}

interface Props<R extends { id: number }> {
  rows: readonly R[];
  renderRow(row: R, index: number, style: React.CSSProperties): ReactNode;
  onNearEnd(): void;
  resetToken: number;
  keepIndex: number | null;
  footer: ReactNode;
  label: string;
  className?: string;
}

function VirtualListInner<R extends { id: number }>(
  { rows, renderRow, onNearEnd, resetToken, keepIndex, footer, label, className }: Props<R>,
  ref: React.ForwardedRef<VirtualListHandle>,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef(keepIndex);
  keepRef.current = keepIndex;

  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    const keep = keepRef.current;
    if (keep !== null && keep >= 0 && keep < range.count && !indexes.includes(keep)) {
      indexes.push(keep);
      indexes.sort((a, b) => a - b);
    }
    return indexes;
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? index,
    rangeExtractor,
  });

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: 'auto' }),
  }));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetToken]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const lastVisible = Math.floor((el.scrollTop + el.clientHeight) / ROW_HEIGHT);
    if (lastVisible >= rows.length - NEAR_END) onNearEnd();
  };

  const items = virtualizer.getVirtualItems();
  return (
    <div
      ref={scrollRef}
      className={`list-scroll ${className ?? ''}`}
      onScroll={onScroll}
      role="list"
      aria-label={label}
    >
      <div className="list-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return renderRow(row, item.index, { top: item.start, height: ROW_HEIGHT });
        })}
      </div>
      {footer}
    </div>
  );
}

export const VirtualList = forwardRef(VirtualListInner) as <R extends { id: number }>(
  props: Props<R> & { ref?: React.Ref<VirtualListHandle> },
) => ReturnType<typeof VirtualListInner>;
