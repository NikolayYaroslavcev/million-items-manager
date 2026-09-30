import { fmt, type Theme } from '../app/hooks.js';
import type { Snapshot } from '../sync/engine.js';

const STATUS_TEXT = {
  online: 'Онлайн',
  delayed: 'Обновления с задержкой',
  connecting: 'Подключение…',
  offline: 'Нет связи',
} as const;

const THEME_NAME = { system: 'системная', dark: 'тёмная', light: 'светлая' } as const;

export function Header({
  snap,
  theme,
  setTheme,
}: {
  snap: Snapshot;
  theme: Theme;
  setTheme(theme: Theme): void;
}) {
  const next: Theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
  const state = snap.connection.state;

  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <h1>Million Items</h1>
      </div>
      <dl className="stats">
        <div>
          <dt>Всего</dt>
          <dd data-testid="count-all">{snap.counts ? fmt(snap.counts.all) : '—'}</dd>
        </div>
        <div>
          <dt>Выбрано</dt>
          <dd data-testid="count-selected">{snap.counts ? fmt(snap.counts.selected) : '—'}</dd>
        </div>
      </dl>
      <div className="header-end">
        <span
          className={`conn conn-${state}`}
          role="status"
          data-testid="connection"
          data-mode={snap.connection.mode}
          title={
            snap.connection.mode === 'polling'
              ? 'Поток событий недоступен — изменения запрашиваются каждые 2 секунды'
              : 'Изменения приходят в реальном времени'
          }
        >
          <span className="conn-dot" aria-hidden="true" />
          {STATUS_TEXT[state]}
        </span>
        <button
          type="button"
          className="icon-btn theme-btn"
          onClick={() => setTheme(next)}
          aria-label={`Тема: ${THEME_NAME[theme]}. Переключить`}
          title={`Тема: ${THEME_NAME[theme]}`}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {theme === 'dark' ? (
              <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" fill="currentColor" />
            ) : theme === 'light' ? (
              <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="8" cy="8" r="3" />
                <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
              </g>
            ) : (
              <g stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="5.5" fill="none" />
                <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
              </g>
            )}
          </svg>
        </button>
      </div>
    </header>
  );
}
