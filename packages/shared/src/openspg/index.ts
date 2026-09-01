export { OpenSpgClient, type OpenSpgClientOptions } from './client.js';
export { listModels, ensureEmbeddingModel, type ModelEntry, type EnsureEmbeddingModelParams } from './models.js';
export {
  listProjects, findProjectByNamespace, createProject, commitSchema, getSchemaGraph,
  type OpenSpgProject, type CreateProjectParams,
} from './projects.js';
export {
  uploadFile, buildCsvUpsertJobPayload, submitCsvUpsertJob, getJob, listJobs, waitForJob,
  isReusableActiveJob, TERMINAL_JOB_STATUSES, ACTIVE_JOB_STATUSES,
  type BuilderJob, type UploadSource, type SubmitCsvUpsertJobParams, type WaitForJobOptions,
} from './builder.js';
export {
  searchText, searchVector, normalizeSearchResponse, probeSearch, rrfFuse,
  type SearchShape, type SearchHit, type NormalizedSearch, type SearchTextParams,
  type SearchVectorParams, type SearchProbeResult, type RankedList, type FusedHit,
} from './search.js';
