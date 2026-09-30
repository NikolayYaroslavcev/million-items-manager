export function nextMatch(x: number, s: string, max: number): number | null {
  const lower = Math.max(1, Math.ceil(x));
  if (lower > max || s.length === 0) return lower <= max ? lower : null;
  const maxLen = String(max).length;
  const lowerStr = String(lower);
  for (let len = Math.max(lowerStr.length, s.length); len <= maxLen; len++) {
    const bound = len === lowerStr.length ? lowerStr : '1' + '0'.repeat(len - 1);
    let best: string | null = null;
    for (let p = 0; p + s.length <= len; p++) {
      const candidate = minWithPatternAt(bound, s, p);
      if (candidate !== null && (best === null || candidate < best)) best = candidate;
    }
    if (best !== null) {
      const y = Number(best);
      return y <= max ? y : null;
    }
  }
  return null;
}

function minWithPatternAt(bound: string, s: string, p: number): string | null {
  const len = bound.length;
  const fixedAt = (i: number): string | null => (i >= p && i < p + s.length ? s[i - p]! : null);

  let divergeAt = -1;
  let divergeDigit = '';
  let exact = true;
  for (let i = 0; i < len; i++) {
    const b = bound[i]!;
    const f = fixedAt(i);
    if (f !== null) {
      if (f > b) {
        divergeAt = i;
        divergeDigit = f;
      }
      if (f !== b) {
        exact = false;
        break;
      }
    } else if (b < '9') {
      divergeAt = i;
      divergeDigit = String.fromCharCode(b.charCodeAt(0) + 1);
    }
  }
  if (exact) return bound;
  if (divergeAt < 0) return null;
  let out = bound.slice(0, divergeAt) + divergeDigit;
  for (let i = divergeAt + 1; i < len; i++) out += fixedAt(i) ?? '0';
  return out;
}
