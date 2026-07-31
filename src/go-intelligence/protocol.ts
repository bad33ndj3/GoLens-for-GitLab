import * as v from 'valibot';

import type { SourceIdentity } from '../domain.ts';
import type { CacheInspection, ClearCacheRequest, CoverageRequest, SemanticQuery } from './index.ts';
import type { CoverageManifest, SourceFile } from './cache.ts';

export const WORKER_PROTOCOL = 1 as const;

export class IntelligenceContractError extends Error {
  override readonly name = 'IntelligenceContractError';
}

export type WorkerCommand =
  | Readonly<{ name: 'prepare-coverage'; request: CoverageRequest; manifest?: CoverageManifest }>
  | Readonly<{ name: 'store-sources'; files: readonly SourceFile[] }>
  | Readonly<{ name: 'publish-coverage'; manifest: CoverageManifest }>
  | Readonly<{ name: 'query'; query: SemanticQuery }>
  | Readonly<{ name: 'inspect-cache'; inspection: CacheInspection }>
  | Readonly<{ name: 'clear-cache'; request: ClearCacheRequest }>
  | Readonly<{ name: 'dispose-memory' }>;

export type WorkerRequest = Readonly<{
  protocol: 1;
  clientId: string;
  requestId: string;
  operationId: string;
  source?: SourceIdentity;
  command: WorkerCommand;
}>;

export type WorkerResponse =
  | Readonly<{ protocol: 1; clientId: string; requestId: string; ok: true; value: unknown }>
  | Readonly<{ protocol: 1; clientId: string; requestId: string; ok: false; error: WorkerError }>;

export type WorkerError = Readonly<{
  code: 'aborted' | 'contract-error' | 'protocol-mismatch' | 'unknown-command' | 'unavailable';
  message: string;
}>;

export type CancelMessage = Readonly<{ protocol: 1; clientId: string; operationId: string; cancel: true }>;

const nonEmpty = v.pipe(v.string(), v.minLength(1));
const path = v.pipe(nonEmpty, v.check((value) => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
  && value.split('/').every((part) => part && part !== '.' && part !== '..'), 'Invalid repository path.'));
const source = v.strictObject({ repositoryKey: nonEmpty, commitSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)) });
const entry = v.strictObject({ path, contentId: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i)) });
const file = v.strictObject({ ...entry.entries, source: v.string() });
const coverageBase = {
  complete: v.boolean(), packageCount: v.pipe(v.number(), v.integer(), v.minValue(0)), packagePaths: v.array(v.string()),
  limitation: v.optional(v.picklist(['bounded', 'search-limited', 'search-unavailable'])),
};
const coverage = v.variant('scope', [
  v.strictObject({ scope: v.literal('current-package'), ...coverageBase }),
  v.strictObject({ scope: v.literal('indexed-packages'), ...coverageBase }),
  v.strictObject({ scope: v.literal('full-project'), ...coverageBase }),
  v.strictObject({ scope: v.literal('complete-project-search'), ...coverageBase, queryFingerprint: nonEmpty, searchStrategy: nonEmpty }),
]);
const manifest = v.strictObject({ source, modulePath: v.string(), coverage, files: v.array(entry) });
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const symbol = v.strictObject({
  source, path, line: positiveInteger, column: positiveInteger,
  kind: v.picklist(['constant', 'field', 'function', 'interface', 'interfaceMethod', 'method', 'parameter', 'struct', 'type', 'variable']),
  name: nonEmpty,
});
const query = v.variant('operation', [
  v.strictObject({ operation: v.literal('resolve-symbol'), path, line: positiveInteger, column: positiveInteger, identifier: nonEmpty, occurrence: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))) }),
  v.strictObject({ operation: v.literal('find-references'), symbol, pageSize: v.optional(positiveInteger), pageToken: v.optional(v.string()) }),
  v.strictObject({ operation: v.literal('find-implementations'), symbol, pageSize: v.optional(positiveInteger), pageToken: v.optional(v.string()) }),
]);
const coverageRequest = v.variant('goal', [
  v.strictObject({ goal: v.literal('current-package'), packagePath: v.optional(v.string()) }),
  v.strictObject({ goal: v.literal('related-review'), changedPaths: v.optional(v.array(path)) }),
  v.strictObject({ goal: v.literal('complete-query'), query: v.optional(query) }),
  v.strictObject({ goal: v.literal('full-project') }),
]);
const command = v.variant('name', [
  v.strictObject({ name: v.literal('prepare-coverage'), request: coverageRequest, manifest: v.optional(manifest) }),
  v.strictObject({ name: v.literal('store-sources'), files: v.array(file) }),
  v.strictObject({ name: v.literal('publish-coverage'), manifest }),
  v.strictObject({ name: v.literal('query'), query }),
  v.strictObject({ name: v.literal('inspect-cache'), inspection: v.strictObject({ scope: v.picklist(['source', 'global']) }) }),
  v.strictObject({ name: v.literal('clear-cache'), request: v.strictObject({ scope: v.literal('global') }) }),
  v.strictObject({ name: v.literal('dispose-memory') }),
]);
const requestSchema = v.strictObject({
  protocol: v.literal(WORKER_PROTOCOL), clientId: nonEmpty, requestId: nonEmpty, operationId: nonEmpty,
  source: v.optional(source), command,
});
const errorSchema = v.strictObject({ code: v.picklist(['aborted', 'contract-error', 'protocol-mismatch', 'unknown-command', 'unavailable']), message: v.string() });
const responseSchema = v.variant('ok', [
  v.strictObject({ protocol: v.literal(WORKER_PROTOCOL), clientId: nonEmpty, requestId: nonEmpty, ok: v.literal(true), value: v.unknown() }),
  v.strictObject({ protocol: v.literal(WORKER_PROTOCOL), clientId: nonEmpty, requestId: nonEmpty, ok: v.literal(false), error: errorSchema }),
]);
const cancelSchema = v.strictObject({ protocol: v.literal(WORKER_PROTOCOL), clientId: nonEmpty, operationId: nonEmpty, cancel: v.literal(true) });
const snapshot = nonEmpty;
const context = { source, snapshot, coverage };
const location = v.strictObject({ path, line: positiveInteger, column: positiveInteger });
const definition = v.strictObject({
  identity: symbol, signature: v.string(), compactSignature: v.optional(v.string()), documentation: v.string(),
  documentationLine: v.pipe(v.number(), v.integer(), v.minValue(0)), receiver: v.optional(v.string()),
  packageName: v.string(), packagePath: v.string(), fullTypeBody: v.optional(v.string()),
});
const semanticOutcome = v.variant('status', [
  v.strictObject({ ...context, status: v.literal('resolved'), symbol: definition, isDefinition: v.boolean() }),
  v.strictObject({ ...context, status: v.literal('references'), symbol, locations: v.array(location), nextPageToken: v.optional(v.string()) }),
  v.strictObject({
    ...context, status: v.literal('implementations'), symbol,
    candidates: v.array(v.strictObject({
      definition, displayName: v.string(), pointer: v.boolean(), matchedMethods: v.number(), methodCount: v.number(),
      confidence: v.picklist(['asserted', 'structural']), isTestDouble: v.boolean(),
    })),
    nextPageToken: v.optional(v.string()),
  }),
  v.strictObject({ ...context, status: v.literal('ambiguous'), reason: v.picklist(['multiple-definitions', 'receiver-or-selector']), candidates: v.array(definition) }),
  v.strictObject({ ...context, status: v.literal('external'), packageKind: v.picklist(['builtin', 'project', 'standard-library', 'third-party']), importPath: v.optional(v.string()), symbol: v.string() }),
  v.strictObject({ ...context, status: v.literal('unsupported'), reason: v.picklist(['build-constraint', 'dot-import', 'single-root-module', 'type-set-constraint', 'unresolved-embedding']) }),
  v.strictObject({ ...context, status: v.literal('missing'), reason: v.picklist(['identifier', 'definition', 'symbol']) }),
  v.strictObject({ ...context, status: v.literal('coverage-insufficient'), required: v.picklist(['current-package', 'indexed-packages', 'complete-project-search', 'full-project']), reason: v.string() }),
  v.strictObject({ ...context, status: v.literal('stale-page') }),
  v.strictObject({ ...context, status: v.literal('unavailable'), reason: v.string() }),
]);
const cacheSnapshot = v.strictObject({
  sourceBlobs: v.pipe(v.number(), v.integer(), v.minValue(0)), packageManifests: v.pipe(v.number(), v.integer(), v.minValue(0)),
  projectManifests: v.pipe(v.number(), v.integer(), v.minValue(0)), bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const resultSchemas = {
  'prepare-coverage': v.variant('status', [
    v.strictObject({ status: v.literal('missing') }),
    v.strictObject({ status: v.literal('prepared'), cached: v.pipe(v.number(), v.integer(), v.minValue(0)), missing: v.array(entry) }),
    v.strictObject({ ...context, status: v.literal('ready'), reason: v.optional(v.string()) }),
  ]),
  'store-sources': v.strictObject({ status: v.literal('ok') }),
  'publish-coverage': v.strictObject({ ...context, status: v.picklist(['ready', 'unsupported', 'unavailable']), reason: v.optional(v.string()) }),
  query: semanticOutcome,
  'inspect-cache': cacheSnapshot,
  'clear-cache': v.strictObject({ status: v.literal('cleared'), ...cacheSnapshot.entries }),
  'dispose-memory': v.strictObject({ status: v.literal('ok') }),
} as const;

export function parseWorkerRequest(value: unknown): WorkerRequest | null {
  const result = v.safeParse(requestSchema, value);
  return result.success ? result.output as WorkerRequest : null;
}

export function parseWorkerResponse(value: unknown): WorkerResponse | null {
  const result = v.safeParse(responseSchema, value);
  return result.success ? result.output : null;
}

export function parseCancelMessage(value: unknown): CancelMessage | null {
  const result = v.safeParse(cancelSchema, value);
  return result.success ? result.output : null;
}

export function workerError(code: WorkerError['code'], message: string): WorkerError {
  return Object.freeze({ code, message });
}

export function validWorkerValue(command: WorkerCommand['name'], value: unknown): boolean {
  return v.safeParse(resultSchemas[command], value).success;
}
