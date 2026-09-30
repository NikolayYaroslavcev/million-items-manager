export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const nl = this.buffer.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      if (this.buffer[nl] === '\r' && nl === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      this.line(line, out);
    }
    return out;
  }

  private line(line: string, out: SseMessage[]): void {
    if (line === '') {
      if (this.data.length > 0) {
        out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
      }
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.id = value;
  }
}

export type StreamResult =
  | { kind: 'refused'; status: number; code: string | null }
  | { kind: 'ended' }
  | { kind: 'failed'; error: unknown };

export interface StreamHandlers {
  onActivity(): void;
  onMessage(message: SseMessage): void;
  onOpen?(): void;
}

export async function readEventStream(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<StreamResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    return { kind: 'failed', error };
  }
  if (!res.ok || !res.body) {
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: { code?: string } };
      code = body.error?.code ?? null;
    } catch {}
    return { kind: 'refused', status: res.status, code };
  }
  handlers.onOpen?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = (): void => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) return { kind: 'failed', error: signal.reason };
      const { done, value } = await reader.read();
      if (done) return { kind: 'ended' };
      handlers.onActivity();
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        handlers.onMessage(message);
      }
    }
  } catch (error) {
    return { kind: 'failed', error };
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}
