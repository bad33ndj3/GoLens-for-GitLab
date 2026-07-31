import type { RepositoryPath, SourceIdentity } from '../domain.ts';

export type SourceContent = Readonly<{ path: RepositoryPath; contentId: string }>;

export interface SourceReader {
  discover(request: CoverageRequest, signal: AbortSignal): Promise<Readonly<{
    modulePath: string;
    coverage: Coverage;
    files: readonly SourceContent[];
  }>>;
  read(source: SourceContent, signal: AbortSignal): Promise<string>;
}

export type SemanticSnapshotRevision = string;

export type CoverageScope =
  | 'current-package'
  | 'indexed-packages'
  | 'complete-project-search'
  | 'full-project';

export type CoverageLimitation = 'bounded' | 'search-limited' | 'search-unavailable';

type CoverageBase = Readonly<{
  complete: boolean;
  packageCount: number;
  packagePaths: readonly string[];
  limitation?: CoverageLimitation;
}>;

export type Coverage = CoverageBase & (
  | Readonly<{ scope: Exclude<CoverageScope, 'complete-project-search'> }>
  | Readonly<{ scope: 'complete-project-search'; queryFingerprint: string; searchStrategy: string }>
);

export type SourceLocation = Readonly<{
  path: RepositoryPath;
  line: number;
  column: number;
}>;

export type SymbolKind =
  | 'constant'
  | 'field'
  | 'function'
  | 'interface'
  | 'interfaceMethod'
  | 'method'
  | 'parameter'
  | 'struct'
  | 'type'
  | 'variable';

export type SymbolIdentity = Readonly<{
  source: SourceIdentity;
  path: RepositoryPath;
  line: number;
  column: number;
  kind: SymbolKind;
  name: string;
}>;

export type SymbolDefinition = Readonly<{
  identity: SymbolIdentity;
  signature: string;
  compactSignature?: string;
  documentation: string;
  documentationLine: number;
  receiver?: string;
  packageName: string;
  packagePath: string;
  fullTypeBody?: string;
}>;

export type ImplementationCandidate = Readonly<{
  definition: SymbolDefinition;
  displayName: string;
  pointer: boolean;
  matchedMethods: number;
  methodCount: number;
  confidence: 'asserted' | 'structural';
  isTestDouble: boolean;
}>;

export type ResolveSymbolQuery = Readonly<{
  operation: 'resolve-symbol';
  path: RepositoryPath;
  line: number;
  column: number;
  identifier: string;
  occurrence?: number;
}>;

export type FindReferencesQuery = Readonly<{
  operation: 'find-references';
  symbol: SymbolIdentity;
  pageSize?: number;
  pageToken?: string;
}>;

export type FindImplementationsQuery = Readonly<{
  operation: 'find-implementations';
  symbol: SymbolIdentity;
  pageSize?: number;
  pageToken?: string;
}>;

export type SemanticQuery = ResolveSymbolQuery | FindReferencesQuery | FindImplementationsQuery;

type OutcomeContext = Readonly<{
  source: SourceIdentity;
  snapshot: SemanticSnapshotRevision;
  coverage: Coverage;
}>;

export type SemanticOutcome = OutcomeContext & (
  | Readonly<{ status: 'resolved'; symbol: SymbolDefinition; isDefinition: boolean }>
  | Readonly<{ status: 'references'; symbol: SymbolIdentity; locations: readonly SourceLocation[]; nextPageToken?: string }>
  | Readonly<{ status: 'implementations'; symbol: SymbolIdentity; candidates: readonly ImplementationCandidate[]; nextPageToken?: string }>
  | Readonly<{ status: 'ambiguous'; reason: 'multiple-definitions' | 'receiver-or-selector'; candidates: readonly SymbolDefinition[] }>
  | Readonly<{ status: 'external'; packageKind: 'builtin' | 'project' | 'standard-library' | 'third-party'; importPath?: string; symbol: string }>
  | Readonly<{ status: 'unsupported'; reason: 'build-constraint' | 'dot-import' | 'single-root-module' | 'type-set-constraint' | 'unresolved-embedding' }>
  | Readonly<{ status: 'missing'; reason: 'identifier' | 'definition' | 'symbol' }>
  | Readonly<{ status: 'coverage-insufficient'; required: CoverageScope; reason: string }>
  | Readonly<{ status: 'stale-page' }>
  | Readonly<{ status: 'unavailable'; reason: string }>
);

export type CoverageRequest = Readonly<{
  goal: 'current-package' | 'related-review' | 'complete-query' | 'full-project';
  packagePath?: string;
  changedPaths?: readonly RepositoryPath[];
  query?: SemanticQuery;
}>;

export type CoverageProgress = Readonly<{
  phase: 'checking-cache' | 'discovering' | 'fetching' | 'indexing' | 'publishing' | 'ready';
  completed: number;
  total?: number;
  cached: number;
  downloaded: number;
  remainingFiles?: number;
  packageCount: number;
}>;

export type CoverageOutcome = Readonly<{
  status: 'ready' | 'unsupported' | 'unavailable';
  source: SourceIdentity;
  snapshot: SemanticSnapshotRevision;
  coverage: Coverage;
  reason?: string;
}>;

export type CacheInspection = Readonly<{ scope: 'source' | 'global' }>;
export type CacheSnapshot = Readonly<{
  sourceBlobs: number;
  packageManifests: number;
  projectManifests: number;
  bytes: number;
}>;
export type ClearCacheRequest = Readonly<{ scope: 'global' }>;
export type ClearOutcome = CacheSnapshot & Readonly<{ status: 'cleared' }>;

export interface GoIntelligence {
  query(request: SemanticQuery, signal: AbortSignal): Promise<SemanticOutcome>;
  ensureCoverage(
    request: CoverageRequest,
    progress: (update: CoverageProgress) => void,
    signal: AbortSignal,
  ): Promise<CoverageOutcome>;
  inspectCache(request: CacheInspection, signal: AbortSignal): Promise<CacheSnapshot>;
  clearCache(request: ClearCacheRequest, signal: AbortSignal): Promise<ClearOutcome>;
}

type Runtime = Parameters<typeof createGoIntelligence>[0]['runtime'];

export function openGoIntelligence({
  source,
  reader,
  runtime = chrome.runtime as unknown as Runtime,
}: {
  source: SourceIdentity;
  reader: SourceReader;
  runtime?: Runtime;
}): GoIntelligence {
  return createGoIntelligence({ source, reader, runtime });
}

export { startGoIntelligenceWorker } from './worker-runtime.ts';
export { IntelligenceContractError } from './protocol.ts';

import { createGoIntelligence } from './client.ts';
