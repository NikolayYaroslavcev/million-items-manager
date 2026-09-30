import { BASE_MAX, MAX_ID } from '@mim/shared';

const nf = new Intl.NumberFormat('ru-RU');

export const digitsOnly = (value: string, max: number): string =>
  value.replace(/\D+/g, '').slice(0, max);

export function validateNewId(raw: string, pending: (id: number) => boolean): string | null {
  if (raw === '') return null;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id > MAX_ID) return 'Слишком большое число';
  if (id < 1) return 'ID должен быть больше нуля';
  if (id <= BASE_MAX) return `ID от 1 до ${nf.format(BASE_MAX)} уже существуют`;
  if (pending(id)) return 'Этот ID уже в очереди';
  return null;
}

export function secondsToAdd(
  nextAddAt: number | null,
  now: number,
  period = 10_000,
): number | null {
  if (nextAddAt === null) return null;
  const left = (((nextAddAt - now) % period) + period) % period;
  return Math.ceil(left / 1000) || period / 1000;
}
