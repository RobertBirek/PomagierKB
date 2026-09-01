import type { FastifyInstance } from 'fastify';
import { AppError } from '@pomagierkb/shared/errors';
import { answerQuestion } from '@pomagierkb/shared/answer';
import type { FeedbackVerdict } from '@pomagierkb/shared/db';
import {
  activeNamespaces,
  assertKnownNamespaces,
  createAskService,
  listAskHistory,
  submitAskFeedback,
} from '../services/ask.js';
import { humanize } from '../services/messages.js';

/**
 * Trasy /api/v1/ask — panelowe pytania do bazy wiedzy (pipeline WSPÓLNY z MCP
 * kb_answer — packages/shared/answer):
 * - POST /ask                    — viewer; SSE: status(phase) → result → close;
 *                                  zapis answers z source 'panel' + user_id;
 *                                  limit 'mutation' + 10/min per sesja (koszt LLM);
 * - GET  /ask/history            — viewer; ostatnie 50 odpowiedzi TEGO użytkownika;
 * - POST /ask/:answerId/feedback — viewer; up/down (+komentarz); down → luka wiedzy.
 * Logika w services/ask.ts; ścieżki BEZ prefiksu /api/v1 (dodaje rejestracja).
 */

const ANSWER_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' } as const;
const errorRef = { $ref: 'https://pomagierkb/schemas/envelope-error.json#' } as const;

interface AskBody {
  question: string;
  namespaces?: string[];
}

interface FeedbackBody {
  verdict: FeedbackVerdict;
  comment?: string;
}

export default async function askRoutes(app: FastifyInstance): Promise<void> {
  const service = createAskService({ db: app.db, config: app.config });

  // ── POST /ask — SSE (status → result), koperta błędu tylko PRZED hijackiem ─
  app.post<{ Body: AskBody }>(
    '/ask',
    {
      // audit:false — trasa SSE nie przechodzi przez onResponse (plugins/sse.ts);
      // sama odpowiedź i tak ląduje w answers (source 'panel' + user_id).
      config: { rbac: 'viewer', audit: false, csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['question'],
          properties: {
            question: { type: 'string', minLength: 5, maxLength: 2000 },
            namespaces: {
              type: 'array',
              maxItems: 10,
              items: { type: 'string', minLength: 1, maxLength: 64 },
            },
          },
        },
        response: { '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req, reply) => {
      const user = req.user!; // rbac 'viewer' gwarantuje zalogowanie

      // Wszystkie bramki PRZED hijackiem — błędy wychodzą normalną kopertą:
      // dodatkowy limit ask 10/min per sesja (jak kb_answer w MCP) …
      service.consumeAskLimit(user.sessionHash);
      // … dozwolone namespaces = WSZYSTKIE aktywne KB z rejestru …
      const allowed = activeNamespaces(app.db);
      assertKnownNamespaces(req.body.namespaces, allowed);
      // … i LLM musi być skonfigurowany (spójnie z kb_answer w MCP).
      const llm = service.getLlm();
      if (llm === null) {
        throw new AppError('not_ready', 'LLM nie jest skonfigurowany (Ustawienia → LLM) — /ask jest niedostępne');
      }

      const sink = reply.sse();
      try {
        const result = await answerQuestion(
          { db: app.db, llm, openspg: service.getOpenspg(), log: req.log },
          {
            question: req.body.question,
            allowedNamespaces: allowed,
            ...(req.body.namespaces !== undefined ? { namespaces: req.body.namespaces } : {}),
            source: 'panel',
            userId: user.id,
            onPhase: (phase) => sink.send('status', { phase, label: humanize(phase).label }),
          },
        );
        sink.send('result', {
          answer: result.answer,
          citations: result.citations,
          confidence: result.confidence,
          noAnswer: result.noAnswer,
          degraded: result.degraded,
          answerId: result.answerId,
        });
      } catch (err) {
        // Po hijacku koperta HTTP już nie wyjdzie — błąd jako event 'error'.
        req.log.error({ err }, 'ask: pipeline odpowiedzi zawiódł');
        const code = err instanceof AppError ? err.code : 'internal';
        sink.send('error', { code, label: humanize(code).label });
      } finally {
        sink.close();
      }
    },
  );

  // ── GET /ask/history — ostatnie 50 odpowiedzi TEGO użytkownika ────────────
  app.get(
    '/ask/history',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req) => {
      const items = listAskHistory(app.db, req.user!.id, 50);
      return { ok: true as const, data: { items } };
    },
  );

  // ── POST /ask/:answerId/feedback — up/down; down → luka wiedzy ────────────
  app.post<{ Params: { answerId: string }; Body: FeedbackBody }>(
    '/ask/:answerId/feedback',
    {
      config: { rbac: 'viewer', audit: 'answer.feedback', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['answerId'],
          properties: { answerId: { type: 'string', pattern: ANSWER_ID_PATTERN } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['verdict'],
          properties: {
            verdict: { type: 'string', enum: ['up', 'down'] },
            comment: { type: 'string', maxLength: 2000 },
          },
        },
        response: { 201: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req, reply) => {
      const { feedback, gap } = submitAskFeedback(
        app.db,
        req.params.answerId,
        req.user!.id,
        req.body.verdict,
        req.body.comment ?? null,
      );
      reply.auditContext = {
        resourceType: 'answer',
        resourceId: req.params.answerId,
        after: { verdict: feedback.verdict, gapRecorded: gap !== null },
      };
      return reply.status(201).send({
        ok: true as const,
        data: {
          feedback: {
            id: feedback.id,
            answerId: feedback.answer_id,
            verdict: feedback.verdict,
            comment: feedback.comment,
            createdAt: feedback.created_at,
          },
          gapRecorded: gap !== null,
          ...(gap !== null ? { gapId: gap.id } : {}),
        },
      });
    },
  );
}
