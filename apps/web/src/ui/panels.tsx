import { useDraggable, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmt } from '../app/hooks.js';
import { engine } from '../app/runtime.js';
import type { ListStatus, Snapshot } from '../sync/engine.js';
import type { ListKind } from '../sync/mirror.js';
import type { LeftRow, RightRow } from '../sync/overlay.js';
import { AddIdForm } from './AddIdForm.js';
import { FilterInput, Spinner } from './controls.js';
import { announce } from './live.js';
import { VirtualList, type VirtualListHandle } from './VirtualList.js';

export const dndId = (list: ListKind, id: number): string =>
  `${list === 'items' ? 'L' : 'R'}:${id}`;

function focusRow(list: ListKind, id: number): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-list="${list}"] [data-id="${id}"]`)?.focus();
  });
}

function ListFooter({
  list,
  status,
  done,
  count,
  filter,
}: {
  list: ListKind;
  status: ListStatus;
  done: boolean;
  count: number;
  filter: string;
}) {
  if (status.error) {
    return (
      <div className="list-footer is-error" role="alert">
        <span>Не удалось загрузить: {status.error}</span>
        <button type="button" className="btn btn-quiet" onClick={() => engine.retryList(list)}>
          Повторить
        </button>
      </div>
    );
  }
  if (status.stalled) {
    return (
      <div className="list-footer">
        <span>
          Просмотрено {fmt(status.scanned)} —{' '}
          {count ? 'больше совпадений пока нет' : 'совпадений пока нет'}
        </span>
        <button type="button" className="btn btn-quiet" onClick={() => engine.loadMore(list)}>
          Продолжить поиск
        </button>
      </div>
    );
  }
  if (status.loading) {
    return (
      <div className="list-footer is-loading" aria-live="polite">
        {count === 0 &&
          Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton-row" />)}
        <span className="loading-line">
          <Spinner />{' '}
          {filter && status.scanned > 0 ? `Поиск… просмотрено ${fmt(status.scanned)}` : 'Загрузка…'}
        </span>
      </div>
    );
  }
  if (done && count === 0 && !filter) {
    return (
      <div className="list-footer list-empty">
        <p className="list-empty-title">
          {list === 'selected' ? 'Ничего не выбрано' : 'Все элементы выбраны'}
        </p>
        <p>
          {list === 'selected' ? (
            <>
              Нажмите <span className="kbd">→</span> у строки в списке «Доступные»
              <span className="drag-only"> или перетащите её сюда</span>
            </>
          ) : (
            'Снимите выбор в списке «Выбранные», чтобы вернуть элемент сюда'
          )}
        </p>
      </div>
    );
  }
  if (done) {
    return (
      <div className="list-footer is-end">{count === 0 ? 'Ничего не найдено' : 'Конец списка'}</div>
    );
  }
  return (
    <div className="list-footer">
      <button type="button" className="btn btn-quiet" onClick={() => engine.loadMore(list)}>
        Показать ещё 20
      </button>
    </div>
  );
}

function PanelHeader({
  title,
  total,
  loaded,
  filter,
}: {
  title: string;
  total: number | null;
  loaded: number;
  filter: string;
}) {
  return (
    <div className="panel-title">
      <h2>{title}</h2>
      <span className="panel-count" aria-label={`${title}: ${total ?? 'нет данных'}`}>
        {total === null ? '—' : fmt(total)}
      </span>
      <span className="panel-meta">
        {filter ? `найдено ${fmt(loaded)}` : `загружено ${fmt(loaded)}`}
      </span>
    </div>
  );
}

const LeftRowView = memo(function LeftRowView({
  row,
  index,
  style,
  onKey,
}: {
  row: LeftRow;
  index: number;
  style: React.CSSProperties;
  onKey(e: React.KeyboardEvent, row: LeftRow, index: number): void;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: dndId('items', row.id),
    disabled: row.queued === true,
    data: { list: 'items', id: row.id },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="listitem"
      tabIndex={0}
      data-id={row.id}
      className={`row${row.pending ? ' is-pending' : ''}${isDragging ? ' is-dragging' : ''}${row.queued ? ' is-queued' : ''}`}
      style={style}
      aria-roledescription="элемент"
      aria-label={`ID ${row.id}${row.custom ? ', добавлен' : ''}${row.queued ? ', в очереди' : ''}`}
      onKeyDown={(e) => onKey(e, row, index)}
    >
      <span className="row-id">{row.id}</span>
      {row.custom && !row.queued && <span className="badge">добавлен</span>}
      {row.queued && <span className="badge badge-queued">в очереди</span>}
      <button
        type="button"
        className="row-action"
        disabled={row.queued}
        title={row.queued ? 'Можно выбрать после добавления' : 'Выбрать'}
        aria-label={`Выбрать ${row.id}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => engine.select(row.id)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
});

export function LeftPanel({
  snap,
  rows,
  hidden,
}: {
  snap: Snapshot;
  rows: readonly LeftRow[];
  hidden: boolean;
}) {
  const listRef = useRef<VirtualListHandle>(null);
  const { setNodeRef, isOver } = useDroppable({ id: 'zone:items' });
  const { status, filter, end } = snap.left;
  const total = snap.counts ? snap.counts.all - snap.counts.selected : null;

  const onKey = (e: React.KeyboardEvent, row: LeftRow, index: number): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (row.queued) return;
      engine.select(row.id);
      announce(`ID ${row.id} выбран`);
      const next = rows[index + 1] ?? rows[index - 1];
      if (next) focusRow('items', next.id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[index + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      listRef.current?.scrollToIndex(index + (e.key === 'ArrowDown' ? 1 : -1));
      focusRow('items', next.id);
    }
  };

  return (
    <section
      ref={setNodeRef}
      className={`panel${isOver ? ' is-drop-target' : ''}`}
      data-list="items"
      aria-label="Доступные элементы"
      hidden={hidden}
    >
      <header className="panel-head">
        <PanelHeader title="Доступные" total={total} loaded={rows.length} filter={filter} />
        <FilterInput list="items" label="Фильтр доступных по ID" />
        <AddIdForm />
      </header>
      <VirtualList
        ref={listRef}
        rows={rows}
        label="Доступные"
        resetToken={status.resetToken}
        keepIndex={null}
        onNearEnd={() => engine.loadMore('items')}
        renderRow={(row, index, style) => (
          <LeftRowView key={row.id} row={row} index={index} style={style} onKey={onKey} />
        )}
        footer={
          <ListFooter
            list="items"
            status={status}
            done={end.kind === 'all'}
            count={rows.length}
            filter={filter}
          />
        }
      />
    </section>
  );
}

interface MenuState {
  id: number;
  x: number;
  y: number;
}

const RightRowView = memo(function RightRowView({
  row,
  index,
  style,
  onKey,
  onMenu,
}: {
  row: RightRow;
  index: number;
  style: React.CSSProperties;
  onKey(e: React.KeyboardEvent, row: RightRow, index: number): void;
  onMenu(state: MenuState): void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: dndId('selected', row.id),
    data: { list: 'selected', id: row.id },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      role="listitem"
      tabIndex={0}
      data-id={row.id}
      className={`row${row.pending ? ' is-pending' : ''}${isDragging ? ' is-dragging' : ''}`}
      style={{ ...style, transform: CSS.Translate.toString(transform), transition }}
      aria-roledescription="сортируемый элемент"
      aria-label={`ID ${row.id}, позиция ${index + 1}. Alt+стрелки — переместить, Delete — снять выбор`}
      onKeyDown={(e) => onKey(e, row, index)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ id: row.id, x: e.clientX, y: e.clientY });
      }}
    >
      <span className="drag-handle" {...listeners} aria-hidden="true">
        <svg viewBox="0 0 16 16">
          {[4, 8, 12].map((y) => (
            <g key={y}>
              <circle cx="6" cy={y} r="1.1" />
              <circle cx="10" cy={y} r="1.1" />
            </g>
          ))}
        </svg>
      </span>
      <span className="row-id" {...listeners}>
        {row.id}
      </span>
      <button
        type="button"
        className="row-action row-menu-btn"
        aria-label={`Действия для ${row.id}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu({ id: row.id, x: r.right, y: r.bottom });
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      <button
        type="button"
        className="row-action"
        title="Снять выбор"
        aria-label={`Снять выбор ${row.id}`}
        onClick={() => engine.deselect(row.id)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M13 8H4M7.5 4.5 4 8l3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
});

function RowMenu({ menu, onClose }: { menu: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  const act = (fn: () => void, message: string) => () => {
    fn();
    announce(message);
    onClose();
    focusRow('selected', menu.id);
  };
  const left = Math.min(menu.x, window.innerWidth - 200);
  const top = Math.min(menu.y, window.innerHeight - 140);
  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={`Действия для ${menu.id}`}
      style={{ left, top }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }}
    >
      <button
        role="menuitem"
        type="button"
        onClick={act(
          () => engine.move(menu.id, { position: 'first' }),
          `ID ${menu.id} перемещён в начало`,
        )}
      >
        В начало
      </button>
      <button
        role="menuitem"
        type="button"
        onClick={act(
          () => engine.move(menu.id, { position: 'last' }),
          `ID ${menu.id} перемещён в конец`,
        )}
      >
        В конец
      </button>
      <button
        role="menuitem"
        type="button"
        className="is-danger"
        onClick={act(() => engine.deselect(menu.id), `Выбор ID ${menu.id} снят`)}
      >
        Снять выбор
      </button>
    </div>
  );
}

export function anchorsAt(
  rows: readonly { id: number }[],
  id: number,
  to: number,
): { afterId: number | null; beforeId: number | null } {
  const rest = rows.filter((r) => r.id !== id);
  return { afterId: rest[to - 1]?.id ?? null, beforeId: rest[to]?.id ?? null };
}

export function RightPanel({
  snap,
  rows,
  activeIndex,
  hidden,
}: {
  snap: Snapshot;
  rows: readonly RightRow[];
  activeIndex: number | null;
  hidden: boolean;
}) {
  const listRef = useRef<VirtualListHandle>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const { setNodeRef, isOver } = useDroppable({ id: 'zone:selected' });
  const { status, filter, end } = snap.right;
  const sortableIds = useMemo(() => rows.map((r) => dndId('selected', r.id)), [rows]);

  const moveTo = (row: RightRow, to: number): void => {
    const anchors = anchorsAt(rows, row.id, to);
    if (anchors.afterId === null && anchors.beforeId === null) return;
    engine.move(row.id, anchors);
    announce(`ID ${row.id} перемещён на позицию ${to + 1}`);
    listRef.current?.scrollToIndex(to);
    focusRow('selected', row.id);
  };

  const onKey = (e: React.KeyboardEvent, row: RightRow, index: number): void => {
    if (e.target !== e.currentTarget) return;
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      if (index > 0) moveTo(row, index - 1);
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      if (index < rows.length - 1) moveTo(row, index + 1);
    } else if (e.altKey && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const position = e.key === 'Home' ? 'first' : 'last';
      engine.move(row.id, { position });
      announce(`ID ${row.id} перемещён в ${position === 'first' ? 'начало' : 'конец'}`);
      if (position === 'first') {
        listRef.current?.scrollToIndex(0);
        focusRow('selected', row.id);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      engine.deselect(row.id);
      announce(`Выбор ID ${row.id} снят`);
      const next = rows[index + 1] ?? rows[index - 1];
      if (next) focusRow('selected', next.id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const to = index + (e.key === 'ArrowDown' ? 1 : -1);
      const next = rows[to];
      if (!next) return;
      listRef.current?.scrollToIndex(to);
      focusRow('selected', next.id);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ id: row.id, x: r.left + 40, y: r.bottom });
    }
  };

  return (
    <section
      ref={setNodeRef}
      className={`panel${isOver ? ' is-drop-target' : ''}`}
      data-list="selected"
      aria-label="Выбранные элементы"
      hidden={hidden}
    >
      <header className="panel-head">
        <PanelHeader
          title="Выбранные"
          total={snap.counts?.selected ?? null}
          loaded={rows.length}
          filter={filter}
        />
        <FilterInput list="selected" label="Фильтр выбранных по ID" />
        <p className="panel-hint">
          Перетаскивайте строки, чтобы изменить порядок. Клавиатура: Alt+↑/↓, Alt+Home/End.
        </p>
      </header>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <VirtualList
          ref={listRef}
          rows={rows}
          label="Выбранные"
          resetToken={status.resetToken}
          keepIndex={activeIndex}
          onNearEnd={() => engine.loadMore('selected')}
          renderRow={(row, index, style) => (
            <RightRowView
              key={row.id}
              row={row}
              index={index}
              style={style}
              onKey={onKey}
              onMenu={setMenu}
            />
          )}
          footer={
            <ListFooter
              list="selected"
              status={status}
              done={end.kind === 'all'}
              count={rows.length}
              filter={filter}
            />
          }
        />
      </SortableContext>
      {menu && <RowMenu menu={menu} onClose={closeMenu} />}
    </section>
  );
}
