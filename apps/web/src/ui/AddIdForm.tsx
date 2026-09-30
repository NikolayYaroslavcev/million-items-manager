import { useState } from 'react';
import { useSnapshot, useTicker } from '../app/hooks.js';
import { engine } from '../app/runtime.js';
import { digitsOnly, secondsToAdd, validateNewId } from './validation.js';

export function AddIdForm() {
  const snap = useSnapshot();
  const [value, setValue] = useState('');
  const queued = snap.ops.filter((op) => op.kind === 'add');
  const now = useTicker(queued.length > 0);
  const error = validateNewId(value, (id) => engine.isPendingAdd(id));
  const seconds = secondsToAdd(snap.nextAddAt, now);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!value || error) return;
    engine.add(Number(value));
    setValue('');
  };

  return (
    <form className="add-form" onSubmit={submit} noValidate>
      <div className="add-row">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="Новый ID, например 1000001"
          aria-label="Новый ID"
          aria-invalid={error !== null}
          aria-describedby="add-hint"
          value={value}
          onChange={(e) => setValue(digitsOnly(e.target.value, 16))}
        />
        <button type="submit" className="btn btn-primary" disabled={!value || error !== null}>
          Добавить
        </button>
      </div>
      <p id="add-hint" className={`add-hint${error ? ' is-error' : ''}`} aria-live="polite">
        {error ?? 'Добавления применяются раз в 10 секунд'}
      </p>
      {queued.length > 0 && (
        <ul className="queue" aria-label="Очередь добавления">
          {queued.map((op) => (
            <li key={op.opId} className={`chip${op.state === 'applied' ? ' is-done' : ''}`}>
              <span className="chip-id">{op.id}</span>
              <span className="chip-meta">
                {op.state === 'applied'
                  ? 'добавлен'
                  : op.state === 'waiting'
                    ? 'ждёт отправки'
                    : seconds !== null
                      ? `через ${seconds} с`
                      : 'в очереди'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
