const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function decodeBase64Url(input: string): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error('cursor is not base64url');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

export function cursorPosition(cursor: string, list: 'items'): number;
export function cursorPosition(cursor: string, list: 'selected'): string;
export function cursorPosition(cursor: string, list: 'items' | 'selected'): number | string {
  const parsed = JSON.parse(decodeBase64Url(cursor)) as { list?: unknown; pos?: unknown };
  if (parsed.list !== list) throw new Error(`cursor is for list ${String(parsed.list)}`);
  if (list === 'items' && typeof parsed.pos === 'number') return parsed.pos;
  if (list === 'selected' && typeof parsed.pos === 'string') return parsed.pos;
  throw new Error('cursor has no position');
}
