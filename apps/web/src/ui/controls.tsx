import { FILTER_MAX_LEN } from '@mim/shared';
import { useEffect, useRef, useState } from 'react';
import { engine } from '../app/runtime.js';
import type { ListKind } from '../sync/mirror.js';
import { digitsOnly } from './validation.js';

export function FilterInput({ list, label }: { list: ListKind; label: string }) {
  const [value, setValue] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = (next: string, delay: number): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => engine.setFilter(list, next), delay);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className="filter">
      <svg className="filter-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder="Фильтр по ID"
        aria-label={label}
        value={value}
        maxLength={FILTER_MAX_LEN}
        onChange={(e) => {
          const next = digitsOnly(e.target.value, FILTER_MAX_LEN);
          setValue(next);
          apply(next, 250);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply(value, 0);
          if (e.key === 'Escape' && value) {
            setValue('');
            apply('', 0);
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="icon-btn filter-clear"
          aria-label="Очистить фильтр"
          onClick={() => {
            setValue('');
            apply('', 0);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
