/**
 * Parser strumienia SSE (text/event-stream) — CZYSTA logika bez DOM/fetch,
 * używana przez apiSse() i testowana na sztucznym strumieniu (test/sse.test.ts).
 * Obsługuje: linie `event:`/`data:`/`id:`, komentarze `:`, wielolinijkowe data
 * (łączone '\n'), dispatch na pustej linii, CRLF i podział chunków w środku linii.
 */

export interface SseEvent {
  /** Nazwa zdarzenia; brak linii `event:` → 'message' (zgodnie ze specyfikacją). */
  event: string;
  data: string;
  id?: string;
}

export interface SseParser {
  /** Dokarm parser kolejnym fragmentem tekstu (dowolnie pocięte chunki). */
  push(chunk: string): void;
  /** Koniec strumienia — wyemituj ostatnie zdarzenie, jeśli bufor niepusty. */
  end(): void;
}

export function createSseParser(onEvent: (ev: SseEvent) => void): SseParser {
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  let lastId: string | undefined;

  function dispatch(): void {
    if (dataLines.length === 0 && eventName === '') return;
    const ev: SseEvent = { event: eventName === '' ? 'message' : eventName, data: dataLines.join('\n') };
    if (lastId !== undefined) ev.id = lastId;
    onEvent(ev);
    eventName = '';
    dataLines = [];
  }

  function processLine(line: string): void {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // komentarz / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        eventName = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) lastId = value;
        break;
      default:
        break; // pola nieznane (retry itd.) ignorujemy
    }
  }

  return {
    push(chunk: string): void {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.search(/\r\n|\n|\r/)) !== -1) {
        // '\r' na końcu bufora może być początkiem CRLF przeciętego między chunkami.
        if (buffer[idx] === '\r' && idx === buffer.length - 1) break;
        const sep = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + sep);
        processLine(line);
      }
    },
    end(): void {
      if (buffer !== '') {
        processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
        buffer = '';
      }
      dispatch();
    },
  };
}
