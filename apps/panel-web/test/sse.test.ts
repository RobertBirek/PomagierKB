import { describe, expect, it } from 'vitest';
import { createSseParser, type SseEvent } from '../src/lib/sse';

function collect(chunks: string[], end = true): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((ev) => events.push(ev));
  for (const chunk of chunks) parser.push(chunk);
  if (end) parser.end();
  return events;
}

describe('createSseParser()', () => {
  it('parsuje zdarzenia event/data (kontrakt /api/v1/ask: status → result)', () => {
    const events = collect(['event: status\ndata: {"stage":"retrieval"}\n\nevent: result\ndata: {"answer":"…"}\n\n']);
    expect(events).toEqual([
      { event: 'status', data: '{"stage":"retrieval"}' },
      { event: 'result', data: '{"answer":"…"}' },
    ]);
  });

  it('brak linii event → nazwa "message" (spec SSE)', () => {
    expect(collect(['data: hello\n\n'])).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('wielolinijkowe data łączone przez \\n', () => {
    expect(collect(['data: a\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('chunki pocięte w ŚRODKU linii i separatora CRLF', () => {
    const events = collect(['event: sta', 'tus\r', '\ndata: 1\r\n\r\n']);
    expect(events).toEqual([{ event: 'status', data: '1' }]);
  });

  it('komentarze (keep-alive ":") są ignorowane', () => {
    expect(collect([': ping\n\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('id trafia do zdarzenia', () => {
    expect(collect(['id: 7\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x', id: '7' }]);
  });

  it('end() domyka zdarzenie bez końcowej pustej linii', () => {
    expect(collect(['event: done\ndata: koniec'])).toEqual([{ event: 'done', data: 'koniec' }]);
  });

  it('bez end() niedokończone zdarzenie NIE jest emitowane', () => {
    expect(collect(['data: partial\n'], false)).toEqual([]);
  });

  it('wartość bez spacji po dwukropku też działa', () => {
    expect(collect(['data:x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });
});
