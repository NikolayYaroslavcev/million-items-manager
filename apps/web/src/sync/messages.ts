import type { ApiError } from '../api/http.js';
import type { OpInput } from './overlay.js';

const TEXT: Record<string, string> = {
  VALIDATION_ERROR: 'некорректный запрос',
  INVALID_CURSOR: 'устаревшая позиция списка',
  CURSOR_MISMATCH: 'устаревшая позиция списка',
  INVALID_ANCHOR: 'некорректное место вставки',
  NOT_FOUND: 'такого ID нет',
  ALREADY_EXISTS: 'такой ID уже существует',
  ITEM_PENDING: 'ID ещё ожидает добавления',
  NOT_SELECTED: 'элемент уже не выбран',
  ANCHOR_NOT_FOUND: 'соседний элемент изменился — список обновлён',
  ORDER_CONFLICT: 'соседи поменялись местами — попробуйте ещё раз',
  CURSOR_EXPIRED: 'порядок перестроен — список обновлён',
  HISTORY_EXPIRED: 'история изменений устарела',
  IDEMPOTENCY_KEY_REUSED: 'конфликт повтора запроса',
  CUSTOM_LIMIT_REACHED: 'достигнут лимит добавленных ID',
  RATE_LIMITED: 'слишком много запросов, повторите позже',
  QUEUE_FULL: 'сервер перегружен, операция не применена',
  SHUTTING_DOWN: 'сервер перезапускается, операция не применена',
  SSE_LIMIT: 'слишком много подключений',
  TIMEOUT_NOT_APPLIED: 'сервер не успел, операция не применена',
  INTERNAL: 'ошибка сервера, операция не применена',
  OUTCOME_UNKNOWN: 'сбой сервера — состояние будет обновлено после перезапуска',
  NETWORK: 'нет связи с сервером — результат неизвестен',
  TIMEOUT: 'сервер не ответил — результат неизвестен',
  BAD_RESPONSE: 'некорректный ответ сервера',
  ABORTED: 'запрос отменён',
};

export function describeError(error: ApiError): string {
  if (error.code === 'ALREADY_EXISTS' && error.details.reason === 'concurrent') {
    return 'этот ID только что добавил другой пользователь';
  }
  return TEXT[error.code] ?? error.message;
}

export function describeOp(op: OpInput): string {
  switch (op.kind) {
    case 'add':
      return `Добавление ${op.id}`;
    case 'select':
      return `Выбор ${op.id}`;
    case 'deselect':
      return `Снятие выбора ${op.id}`;
    case 'move':
      return `Перемещение ${op.id}`;
  }
}
