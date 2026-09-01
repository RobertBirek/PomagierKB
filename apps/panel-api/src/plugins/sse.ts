import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SseSink } from '../types.js';

/**
 * Helper SSE: reply.sse() przejmuje odpowiedź (hijack), wysyła nagłówki
 * text/event-stream, utrzymuje heartbeat (komentarz ': hb') co 15 s
 * i sprząta przy rozłączeniu klienta. Użycie (trasa /actions/:id/events):
 *
 *   const stream = reply.sse();
 *   stream.onClose(() => watcher.close());
 *   stream.send('progress', { phase: 'upload', current: 3, total: 12 });
 *   stream.send('status', { status: 'success' }); stream.close();
 *
 * Uwaga: trasa SSE nie przechodzi przez serializację/koperty ani onResponse
 * (audyt) — config.audit dla tras SSE zostaje false.
 */
export function registerSse(app: FastifyInstance): void {
  app.decorateReply('sse', function (this: FastifyReply, opts?: { heartbeatMs?: number }): SseSink {
    const raw = this.raw;
    this.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // wyłącza buforowanie w proxy, które to honorują (nginx); Caddy: flush_interval -1
      'x-accel-buffering': 'no',
    });
    raw.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, opts?.heartbeatMs ?? 15_000);
    heartbeat.unref();

    const closeFns: (() => void)[] = [];
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const fn of closeFns) {
        try {
          fn();
        } catch (err) {
          this.request.log.warn({ err }, 'błąd sprzątania strumienia SSE');
        }
      }
    };
    this.request.raw.on('close', cleanup);

    return {
      send(event: string, data: unknown): void {
        if (closed || raw.writableEnded) return;
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close(): void {
        cleanup();
        if (!raw.writableEnded) raw.end();
      },
      onClose(fn: () => void): void {
        closeFns.push(fn);
      },
    };
  });
}
