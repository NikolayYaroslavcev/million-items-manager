import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { fmt, useLeftRows, useRightRows, useSnapshot, useTheme } from '../app/hooks.js';
import { engine } from '../app/runtime.js';
import type { ListKind } from '../sync/mirror.js';
import { Header } from './Header.js';
import { registerAnnouncer } from './live.js';
import { LeftPanel, RightPanel, anchorsAt } from './panels.js';

interface DragData {
  list: ListKind;
  id: number;
}

const collision: CollisionDetection = (args) => {
  const zones = pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith('zone:')),
  });
  const zone = zones[0];
  if (!zone) return [];
  if (zone.id === 'zone:selected') {
    const rows = closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith('R:')),
    });
    return rows.length ? rows.slice(0, 1) : [zone];
  }
  return [zone];
};

function useNarrow(): boolean {
  const query = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function App() {
  const snap = useSnapshot();
  const leftRows = useLeftRows(snap);
  const rightRows = useRightRows(snap);
  const [active, setActive] = useState<DragData | null>(null);
  const [dropHint, setDropHint] = useState<{ id: number; below: boolean } | null>(null);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<ListKind>('items');
  const narrow = useNarrow();
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    registerAnnouncer(setMessage);
    return () => registerAnnouncer(null);
  }, []);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const activeIndex =
    active?.list === 'selected' ? rightRows.findIndex((r) => r.id === active.id) : null;

  const onDragStart = (e: DragStartEvent): void => {
    setActive(e.active.data.current as DragData);
  };

  const onDragMove = (e: DragMoveEvent): void => {
    const data = e.active.data.current as DragData;
    const over = e.over;
    if (data.list !== 'items' || !over || !String(over.id).startsWith('R:')) {
      if (dropHint) setDropHint(null);
      return;
    }
    const rect = e.active.rect.current.translated;
    const below = rect ? rect.top + rect.height / 2 > over.rect.top + over.rect.height / 2 : false;
    const id = Number(String(over.id).slice(2));
    if (dropHint?.id !== id || dropHint.below !== below) setDropHint({ id, below });
  };

  const onDragEnd = (e: DragEndEvent): void => {
    const data = e.active.data.current as DragData;
    const hint = dropHint;
    setActive(null);
    setDropHint(null);
    const over = e.over;
    if (!over) return;
    const overId = String(over.id);

    if (data.list === 'selected') {
      const from = rightRows.findIndex((r) => r.id === data.id);
      if (from < 0) {
        toast('Элемент сняли с выбора, пока вы его перетаскивали');
        return;
      }
      if (overId === 'zone:items') {
        engine.deselect(data.id);
        setMessage(`Выбор ID ${data.id} снят`);
        return;
      }
      if (!overId.startsWith('R:')) return;
      const to = rightRows.findIndex((r) => r.id === Number(overId.slice(2)));
      if (to < 0 || to === from) return;
      const anchors = anchorsAt(rightRows, data.id, to);
      if (anchors.afterId === null && anchors.beforeId === null) return;
      engine.move(data.id, anchors);
      setMessage(`ID ${data.id} перемещён на позицию ${to + 1}`);
      return;
    }

    if (engine.isPendingAdd(data.id)) return;
    if (overId.startsWith('R:')) {
      const target = rightRows.findIndex((r) => r.id === Number(overId.slice(2)));
      if (target < 0) return;
      const below = hint?.id === Number(overId.slice(2)) ? hint.below : false;
      engine.selectAt(data.id, anchorsAt(rightRows, data.id, below ? target + 1 : target));
      setMessage(`ID ${data.id} выбран`);
    } else if (overId === 'zone:selected') {
      const last = rightRows[rightRows.length - 1];
      engine.selectAt(data.id, last ? { afterId: last.id, beforeId: null } : null);
      setMessage(`ID ${data.id} выбран`);
    }
  };

  const leftTotal = snap.counts ? snap.counts.all - snap.counts.selected : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActive(null);
        setDropHint(null);
      }}
      accessibility={{ screenReaderInstructions: { draggable: '' } }}
    >
      <div className="app">
        <Header snap={snap} theme={theme} setTheme={setTheme} />
        {narrow && (
          <nav className="tabs" role="tablist" aria-label="Списки">
            {(['items', 'selected'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                aria-selected={tab === t}
                className="tab"
                onClick={() => setTab(t)}
              >
                {t === 'items' ? 'Доступные' : 'Выбранные'}
                <span className="tab-count">
                  {t === 'items'
                    ? leftTotal === null
                      ? ''
                      : fmt(leftTotal)
                    : snap.counts
                      ? fmt(snap.counts.selected)
                      : ''}
                </span>
              </button>
            ))}
          </nav>
        )}
        <main className="board">
          <LeftPanel snap={snap} rows={leftRows} hidden={narrow && tab !== 'items'} />
          <RightPanel
            snap={snap}
            rows={rightRows}
            activeIndex={activeIndex !== null && activeIndex >= 0 ? activeIndex : null}
            hidden={narrow && tab !== 'selected'}
          />
        </main>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {message}
        </div>
        {dropHint && (
          <style>{`[data-list="selected"] [data-id="${dropHint.id}"]{box-shadow:inset 0 ${dropHint.below ? '-2px' : '2px'} 0 var(--accent)}`}</style>
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {active && (
          <div className="row row-overlay">
            <span className="row-id">{active.id}</span>
            <span className="overlay-hint">
              {active.list === 'items' ? 'в выбранные' : 'переместить'}
            </span>
          </div>
        )}
      </DragOverlay>
      <Toaster position="bottom-right" theme={theme} closeButton visibleToasts={4} />
    </DndContext>
  );
}
