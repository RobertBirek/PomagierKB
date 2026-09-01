import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Stan stubu OpenSPG trzymany w pamięci; opcjonalnie serializowany do pliku
 * (STUB_STATE_FILE), żeby restart kontenera dev nie gubił projektów/jobów.
 */

export type JobStatus = 'INIT' | 'RUNNING' | 'FINISH' | 'ERROR';

export interface StubProject {
  id: number;
  name: string;
  namespace: string;
  description: string;
  config: Record<string, unknown>;
  createTime: string;
}

export interface StubModel {
  id: number;
  instanceId: string;
  name: string;
  provider: string;
  model: string;
  modelType: string;
  // config celowo BEZ api_key — stub nigdy nie odbija sekretów
  config: Record<string, unknown>;
}

export interface StubEntityType {
  id: number;
  name: string; // pełna nazwa 'Ns.Typ' jak w prawdziwym entityTypeDTOList
}

export interface StubSchema {
  projectId: number;
  dsl: string;
  entityTypeDTOList: StubEntityType[];
}

export interface StubUpload {
  url: string; // pseudo-URL minio zwracany klientowi
  path: string; // lokalna ścieżka zapisanego pliku
  fileName: string;
}

export interface StubJob {
  id: number;
  projectId: number;
  jobName: string;
  fileName: string;
  fileUrl: string;
  createUser: string;
  type: string;
  dataSourceType: string;
  extension: string;
  label: string; // 'Ns.Typ' z mappingConfig.filter[0].s
  status: JobStatus;
  submittedAt: number; // epoch ms — status wyliczany z upływu czasu
  ingested: boolean;
  shouldFail: boolean;
}

export interface StubChunk {
  id: string;
  name: string;
  content: string;
  label: string;
  properties: Record<string, string>;
}

export interface StubState {
  nextProjectId: number;
  nextModelId: number;
  nextTypeId: number;
  nextJobId: number;
  projects: StubProject[];
  models: StubModel[];
  schemas: StubSchema[];
  uploads: StubUpload[];
  jobs: StubJob[];
  chunks: StubChunk[];
}

/** Stan startowy z jednym zarejestrowanym modelem embeddingu (wygoda dev). */
export function emptyState(): StubState {
  return {
    nextProjectId: 1,
    nextModelId: 2,
    nextTypeId: 1,
    nextJobId: 1,
    projects: [],
    models: [
      {
        id: 1,
        instanceId: 'b87d551dc0ffee00c0ffee00c0ffee00',
        name: 'text-embedding-3-small',
        provider: 'OpenAI',
        model: 'text-embedding-3-small',
        modelType: 'embedding',
        config: { model: 'text-embedding-3-small', modelType: 'embedding' },
      },
    ],
    schemas: [],
    uploads: [],
    jobs: [],
    chunks: [],
  };
}

/** Wczytuje stan z pliku; każdy błąd (brak/uszkodzenie) → świeży stan. */
export function loadState(file: string | undefined): StubState {
  if (!file || !existsSync(file)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StubState>;
    const base = emptyState();
    return {
      nextProjectId: raw.nextProjectId ?? base.nextProjectId,
      nextModelId: raw.nextModelId ?? base.nextModelId,
      nextTypeId: raw.nextTypeId ?? base.nextTypeId,
      nextJobId: raw.nextJobId ?? base.nextJobId,
      projects: raw.projects ?? base.projects,
      models: raw.models ?? base.models,
      schemas: raw.schemas ?? base.schemas,
      uploads: raw.uploads ?? base.uploads,
      jobs: raw.jobs ?? base.jobs,
      chunks: raw.chunks ?? base.chunks,
    };
  } catch {
    return emptyState();
  }
}

/** Best-effort zapis stanu; stub dev nie może wywracać się na błędzie IO. */
export function persistState(file: string | undefined, state: StubState): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    // celowo ignorowane — stan pozostaje w pamięci
  }
}

const TYPE_LINE = /^([A-Za-z][A-Za-z0-9_]*)\(([^)]*)\)\s*:\s*(EntityType|ConceptType|EventType)\b/;

/**
 * Prosty parser typów ze schema DSL: linie bez wcięcia w formie
 * 'Nazwa(Etykieta): EntityType'. Zachowuje id istniejących typów (upsert
 * jak w prawdziwym POST /v1/schemas).
 */
export function parseEntityTypes(
  dsl: string,
  namespace: string,
  existing: StubEntityType[],
  nextId: () => number,
): StubEntityType[] {
  let ns = namespace;
  const nsLine = /^namespace\s+([A-Za-z][A-Za-z0-9]*)\s*$/m.exec(dsl);
  if (nsLine?.[1] !== undefined) ns = nsLine[1];

  const byName = new Map(existing.map((t) => [t.name, t.id]));
  const types: StubEntityType[] = [];
  for (const line of dsl.split('\n')) {
    if (/^\s/.test(line)) continue; // właściwości są wcięte — pomijamy
    const m = TYPE_LINE.exec(line);
    if (!m || m[1] === undefined) continue;
    const name = `${ns}.${m[1]}`;
    types.push({ id: byName.get(name) ?? nextId(), name });
  }
  return types;
}
