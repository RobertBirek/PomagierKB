import { getKbOrThrow, transitionKb } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import {
  commitSchema,
  createProject,
  ensureEmbeddingModel,
  findProjectByNamespace,
  getSchemaGraph,
  type OpenSpgProject,
} from '@pomagierkb/shared/openspg';
import { renderSchema } from '../services/schema-template.js';
import {
  finishProvisioning,
  modelNameOf,
  readEmbeddingsSettings,
} from '../services/kb.js';
import type { KbJobContext } from './kb-runner.js';

/**
 * Akcja create_kb — provisioning projektu OpenSPG (idempotentna, wg
 * docs/design/pipeline-frontend.md (b)):
 * status→provisioning → findProjectByNamespace (resume po awarii — bez duplikatu)
 * → ensureEmbeddingModel (model z settings 'llm.embeddings') → createProject
 * z config.vectorizer.modelId → renderSchema → commitSchema → weryfikacja
 * schemas/graph (4 typy) → schema_versions v1 + project_id + ZAMROŻONY
 * vector_model_id + status active. Błąd → status error + czytelny log.
 */

/** Typy bazowe szablonu — wszystkie muszą istnieć w grafie po commitSchema. */
const REQUIRED_TYPES = ['ConceptTaxonomy', 'Topic', 'ReferenceDocument', 'Chunk'] as const;

const TOTAL_STEPS = 6;

/** vectorizer.modelId z configu istniejącego projektu (config bywa JSON-em w stringu). */
function projectVectorModelId(project: OpenSpgProject): string | null {
  let cfg: unknown = project['config'];
  if (typeof cfg === 'string') {
    try {
      cfg = JSON.parse(cfg);
    } catch {
      return null;
    }
  }
  if (!cfg || typeof cfg !== 'object') return null;
  const vectorizer = (cfg as Record<string, unknown>)['vectorizer'];
  if (!vectorizer || typeof vectorizer !== 'object') return null;
  const modelId = (vectorizer as Record<string, unknown>)['modelId'];
  return typeof modelId === 'string' && modelId !== '' ? modelId : null;
}

export async function runCreateKbJob(ctx: KbJobContext): Promise<void> {
  const { db, config, client, namespace } = ctx;
  const step = (n: number, phase: string, message: string): void =>
    ctx.progress({ phase, current: n, total: TOTAL_STEPS, message });

  try {
    // 1) Stan rejestru: draft/error → provisioning; provisioning = resume; active z projektem = już zrobione.
    step(1, 'status', 'Sprawdzanie stanu rejestru KB');
    const kb = getKbOrThrow(db, namespace);
    if (kb.status === 'active' && kb.project_id !== null) {
      ctx.log(`baza ${namespace} jest już sprovisionowana (projekt #${kb.project_id}) — nic do zrobienia`);
      return;
    }
    if (kb.status === 'draft' || kb.status === 'error') {
      transitionKb(db, namespace, 'provisioning');
      ctx.log(`status KB: ${kb.status} → provisioning`);
    } else if (kb.status === 'provisioning') {
      ctx.log('wznowienie provisioningu po przerwanym biegu');
    } else {
      throw new AppError('conflict', `provisioning niemożliwy dla statusu: ${kb.status}`);
    }

    // 2) Resume: projekt o tym namespace mógł już powstać w poprzednim biegu.
    step(2, 'resume-check', 'Szukanie istniejącego projektu OpenSPG');
    const existing = await findProjectByNamespace(client, namespace);
    if (existing) {
      ctx.log(`znaleziono istniejący projekt OpenSPG #${existing.id} — przejmuję (bez duplikatu)`);
    }

    // 3) Model embeddingu z settings (sealed) + rejestr modeli serwera OpenSPG.
    step(3, 'embedding', 'Ustalanie modelu embeddingu');
    const embeddings = readEmbeddingsSettings(db, config);
    if (embeddings === null) {
      throw new AppError(
        'preflight_failed',
        "brak poprawnej konfiguracji 'llm.embeddings' w Ustawieniach (wymagane: model, baseUrl, apiKey) — skonfiguruj embeddingi przed utworzeniem bazy",
      );
    }
    let vectorModelId = existing ? projectVectorModelId(existing) : null;
    if (vectorModelId === null) {
      vectorModelId = await ensureEmbeddingModel(client, {
        model: embeddings.model,
        apiKey: embeddings.apiKey,
        baseUrl: embeddings.baseUrl,
      });
      ctx.log(`model embeddingu w rejestrze OpenSPG: ${modelNameOf(vectorModelId)}`);
    } else {
      ctx.log(`model embeddingu przejęty z istniejącego projektu: ${modelNameOf(vectorModelId)}`);
    }
    // Guard niezmienności: model projektu (istniejącego lub z rejestru KB) musi
    // zgadzać się z ustawieniami — embeddingu NIE wolno zmieniać po utworzeniu.
    if (modelNameOf(vectorModelId) !== embeddings.model) {
      throw new AppError(
        'preflight_failed',
        `model embeddingu projektu ('${modelNameOf(vectorModelId)}') różni się od ustawień ('${embeddings.model}') — modelu NIE wolno zmieniać po utworzeniu projektu`,
      );
    }
    if (kb.vector_model_id !== '' && kb.vector_model_id !== vectorModelId) {
      throw new AppError(
        'preflight_failed',
        `rejestr KB ma zamrożony vector_model_id ('${kb.vector_model_id}') różny od wyliczonego ('${vectorModelId}')`,
      );
    }

    // 4) Projekt: nowy tylko gdy nie istnieje (idempotencja).
    step(4, 'project', existing ? 'Przejmowanie istniejącego projektu' : 'Tworzenie projektu OpenSPG');
    const projectId = existing
      ? Number(existing.id)
      : await createProject(client, {
          name: kb.name,
          namespace,
          description: kb.description,
          vectorizerModelId: vectorModelId,
        });
    if (!Number.isFinite(projectId)) {
      throw new AppError('upstream_error', 'projekt OpenSPG bez poprawnego id', { projectId });
    }
    ctx.log(`projekt OpenSPG: #${projectId}`);

    // 5) Schemat: render szablonu → commit → weryfikacja 4 typów w grafie.
    step(5, 'schema', 'Commit schematu DSL i weryfikacja grafu');
    const rendered = renderSchema(namespace);
    await commitSchema(client, projectId, rendered.content);
    const graph = await getSchemaGraph(client, projectId);
    const missing = REQUIRED_TYPES.filter(
      (t) => !graph.has(`${namespace}.${t}`) && !graph.has(t),
    );
    if (missing.length > 0) {
      throw new AppError(
        'upstream_error',
        `po commitSchema w grafie brakuje typów: ${missing.join(', ')}`,
      );
    }
    ctx.log(`schemat scommitowany (sha256 ${rendered.hash.slice(0, 12)}…), 4 typy bazowe obecne`);

    // 6) Rejestr: schema_versions v1 + project_id + zamrożony model + status active.
    step(6, 'registry', 'Zapis rejestru KB (v1 schematu, status active)');
    finishProvisioning(db, namespace, {
      projectId,
      vectorModelId,
      hash: rendered.hash,
      content: rendered.content,
      createdBy: ctx.startedBy,
    });
    ctx.log(`baza ${namespace} aktywna (projekt #${projectId}, schema v1)`);
  } catch (err) {
    // Czytelny log + status error (tylko z provisioning — inne stany zostawiamy).
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`provisioning nie powiódł się: ${message}`);
    try {
      const current = getKbOrThrow(db, namespace);
      if (current.status === 'provisioning') transitionKb(db, namespace, 'error');
    } catch {
      // Rejestr nieosiągalny — status akcji i tak będzie error.
    }
    throw err;
  }
}
