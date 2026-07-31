import { repositoryPath, type RepositoryPath, type SourceIdentity } from '../domain.ts';
import {
  IntelligenceContractError,
  type Coverage,
  type ImplementationCandidate,
  type SemanticOutcome,
  type SemanticQuery,
  type SemanticSnapshotRevision,
  type SourceLocation,
  type SymbolDefinition,
  type SymbolIdentity,
  type SymbolKind,
} from './index.ts';
import { GoSemanticIndex } from './semantic-parser.ts';

type SourceFile = Readonly<{ path: RepositoryPath; source: string }>;
type RawResult = { status: string; [key: string]: any };
type SemanticEngine = {
  indexPackage(request: Record<string, unknown>): RawResult;
  indexProject(request: Record<string, unknown>): RawResult;
  resolve(request: Record<string, unknown>): RawResult;
  findReferences(request: Record<string, unknown>): RawResult;
  findImplementations(request: Record<string, unknown>): RawResult;
};
type RawDefinition = Record<string, unknown> & {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  column: number;
  ref: string;
};
type PageState = Readonly<{
  source: SourceIdentity;
  snapshot: string;
  fingerprint: string;
  pageSize: number;
  cursor: string;
}>;

function sameSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.repositoryKey === right.repositoryKey && left.commitSha === right.commitSha;
}

function pageSize(value = 25): number {
  if (!Number.isInteger(value)) throw new IntelligenceContractError('Invalid semantic page size.');
  return Math.max(1, Math.min(100, value));
}

export function semanticQueryFingerprint(query: SemanticQuery): string {
  if (query.operation === 'resolve-symbol') {
    return JSON.stringify([query.operation, query.path, query.line, query.column, query.identifier, query.occurrence ?? null]);
  }
  const { source, path, line, column, kind, name } = query.symbol;
  return JSON.stringify([query.operation, source.repositoryKey, source.commitSha, path, line, column, kind, name]);
}

function fingerprint(query: SemanticQuery, size: number): string {
  return `${semanticQueryFingerprint(query)}\u0000${size}`;
}

function encodePage(state: PageState): string {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  return btoa(String.fromCharCode(...bytes));
}

function decodePage(value: string | undefined): PageState | null {
  if (!value) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as PageState;
  } catch {
    return null;
  }
}

function location(value: { path: string; line: number; column: number }): SourceLocation {
  return Object.freeze({ path: repositoryPath(value.path), line: value.line, column: value.column });
}

export class SemanticSnapshotIndex {
  readonly #engine: SemanticEngine;
  readonly #buildConstrained = new Set<string>();
  readonly #dotImported = new Set<string>();
  readonly #singleRootLimited: ReadonlySet<string>;
  readonly source: SourceIdentity;
  readonly revision: SemanticSnapshotRevision;
  readonly coverage: Coverage;

  constructor(
    parser: unknown,
    source: SourceIdentity,
    revision: SemanticSnapshotRevision,
    coverage: Coverage,
    singleRootLimited: ReadonlySet<RepositoryPath> = new Set(),
  ) {
    this.source = source;
    this.revision = revision;
    this.coverage = Object.freeze({ ...coverage, packagePaths: Object.freeze([...coverage.packagePaths]) });
    this.#singleRootLimited = singleRootLimited;
    this.#engine = new GoSemanticIndex(parser) as unknown as SemanticEngine;
  }

  indexPackage(packagePath: string, files: readonly SourceFile[], modulePath = ''): void {
    this.#recordLimitations(files);
    this.#engine.indexPackage({
      project: this.source.repositoryKey,
      ref: this.source.commitSha,
      packagePath,
      modulePath,
      files,
    });
  }

  indexProject(modulePath: string, files: readonly SourceFile[]): void {
    this.#recordLimitations(files);
    this.#engine.indexProject({
      project: this.source.repositoryKey,
      ref: this.source.commitSha,
      modulePath,
      files,
    });
  }

  query(request: SemanticQuery): SemanticOutcome {
    this.#validateQuery(request);
    const context = { source: this.source, snapshot: this.revision, coverage: this.coverage } as const;
    if (request.operation === 'resolve-symbol') {
      if (this.#singleRootLimited.has(request.path)) return Object.freeze({ ...context, status: 'unsupported', reason: 'single-root-module' });
      if (this.#buildConstrained.has(request.path)) return Object.freeze({ ...context, status: 'unsupported', reason: 'build-constraint' });
      if (this.#dotImported.has(request.path)) return Object.freeze({ ...context, status: 'unsupported', reason: 'dot-import' });
      return this.#resolve(request, context);
    }

    if (!sameSource(request.symbol.source, this.source)) {
      throw new IntelligenceContractError('Symbol belongs to another source identity.');
    }
    const rawDefinition = this.#verifiedDefinition(request.symbol);
    if (!rawDefinition) return this.#absence(context, 'symbol', request);
    const size = pageSize(request.pageSize);
    const queryFingerprint = fingerprint(request, size);
    const page = decodePage(request.pageToken);
    if (request.pageToken && (!page
      || !sameSource(page.source, this.source)
      || page.snapshot !== this.revision
      || page.fingerprint !== queryFingerprint
      || page.pageSize !== size)) {
      return Object.freeze({ ...context, status: 'stale-page' });
    }

    if (request.operation === 'find-references') {
      const result = this.#engine.findReferences({
        project: this.source.repositoryKey,
        ref: this.source.commitSha,
        packagePath: dirname(request.symbol.path),
        definition: rawDefinition,
        pageSize: size,
        cursor: page?.cursor || '',
      });
      if (result.status !== 'references') return this.#absence(context, 'symbol', request);
      const locations = Object.freeze((result.locations as Array<{ path: string; line: number; column: number }>).map(location));
      return Object.freeze({
        ...context,
        status: 'references',
        symbol: request.symbol,
        locations,
        ...(result.hasMore ? { nextPageToken: encodePage({ source: this.source, snapshot: this.revision, fingerprint: queryFingerprint, pageSize: size, cursor: result.nextCursor }) } : {}),
      });
    }

    const result = this.#engine.findImplementations({
      project: this.source.repositoryKey,
      ref: this.source.commitSha,
      interfaceDefinition: rawDefinition,
      pageSize: size,
      cursor: page?.cursor || '',
    });
    if (result.status === 'unsupportedImplementations') {
      const reason = result.reason === 'typeSetConstraint'
        ? 'type-set-constraint'
        : result.reason === 'buildConstraint' ? 'build-constraint' : 'unresolved-embedding';
      return Object.freeze({ ...context, status: 'unsupported', reason });
    }
    if (result.status !== 'implementations') return this.#absence(context, 'symbol', request);
    const candidates = Object.freeze((result.candidates as Array<Record<string, unknown>>).map((candidate) => this.#implementation(candidate, Number(result.methodCount))));
    return Object.freeze({
      ...context,
      status: 'implementations',
      symbol: request.symbol,
      candidates,
      ...(result.hasMore ? { nextPageToken: encodePage({ source: this.source, snapshot: this.revision, fingerprint: queryFingerprint, pageSize: size, cursor: result.nextCursor }) } : {}),
    });
  }

  #resolve(request: Extract<SemanticQuery, { operation: 'resolve-symbol' }>, context: Pick<SemanticOutcome, 'source' | 'snapshot' | 'coverage'>): SemanticOutcome {
    const result = this.#engine.resolve({
      project: this.source.repositoryKey,
      ref: this.source.commitSha,
      packagePath: dirname(request.path),
      path: request.path,
      line: request.line,
      character: request.column - 1,
      identifier: request.identifier,
      occurrence: request.occurrence ?? null,
    });
    if (result.status === 'resolved') {
      return Object.freeze({ ...context, status: 'resolved', symbol: this.#definition(result.definition), isDefinition: result.isDefinition });
    }
    if (result.status === 'ambiguous') {
      return Object.freeze({
        ...context,
        status: 'ambiguous',
        reason: result.reason === 'multipleDefinitions' ? 'multiple-definitions' : 'receiver-or-selector',
        candidates: Object.freeze(result.definitions.map((definition: RawDefinition) => this.#definition(definition))),
      });
    }
    if (result.status === 'unsupported') return Object.freeze({ ...context, status: 'unsupported', reason: 'build-constraint' });
    if (result.status === 'builtin') return Object.freeze({ ...context, status: 'external', packageKind: 'builtin', symbol: result.symbol });
    if (result.status === 'standardLibrary') return Object.freeze({ ...context, status: 'external', packageKind: 'standard-library', importPath: result.importPath, symbol: result.symbol });
    if (result.status === 'packageDocumentation') return Object.freeze({ ...context, status: 'external', packageKind: 'third-party', importPath: result.importPath, symbol: result.symbol });
    if (result.status === 'projectPackage') return Object.freeze({ ...context, status: 'external', packageKind: 'project', importPath: result.importPath, symbol: result.symbol });
    if (result.status === 'needsPackage') {
      if (this.coverage.complete && this.coverage.scope === 'full-project') return this.#absence(context, 'definition', request);
      return Object.freeze({ ...context, status: 'coverage-insufficient', required: 'current-package', reason: `Package ${result.packagePath} is not covered.` });
    }
    return this.#absence(context, result.reason === 'identifierNotFound' ? 'identifier' : 'definition', request);
  }

  #absence(
    context: Pick<SemanticOutcome, 'source' | 'snapshot' | 'coverage'>,
    reason: 'identifier' | 'definition' | 'symbol',
    query: SemanticQuery,
  ): SemanticOutcome {
    const packageCovered = query.operation === 'resolve-symbol' && this.coverage.packagePaths.includes(dirname(query.path));
    const proven = this.coverage.complete && (
      this.coverage.scope === 'full-project'
      || this.coverage.scope === 'complete-project-search' && this.coverage.queryFingerprint === semanticQueryFingerprint(query)
      || this.coverage.scope !== 'complete-project-search' && packageCovered
    );
    return proven
      ? Object.freeze({ ...context, status: 'missing', reason })
      : Object.freeze({ ...context, status: 'coverage-insufficient', required: 'complete-project-search', reason: 'Current Coverage cannot prove absence.' });
  }

  #definition(raw: RawDefinition): SymbolDefinition {
    const identity = Object.freeze({
      source: this.source,
      path: repositoryPath(raw.path),
      line: raw.line,
      column: raw.column,
      kind: raw.kind,
      name: raw.name,
    });
    return Object.freeze({
      identity,
      signature: String(raw.signature || ''),
      ...(raw.compactSignature ? { compactSignature: String(raw.compactSignature) } : {}),
      documentation: String(raw.documentation || ''),
      documentationLine: Number(raw.documentationLine || 0),
      ...(raw.receiver ? { receiver: String(raw.receiver) } : {}),
      packageName: String(raw.packageName || ''),
      packagePath: String(raw.packagePath || ''),
      ...(raw.fullTypeBody ? { fullTypeBody: String(raw.fullTypeBody) } : {}),
    });
  }

  #implementation(raw: Record<string, unknown>, methodCount: number): ImplementationCandidate {
    return Object.freeze({
      definition: this.#definition(raw as RawDefinition),
      displayName: String(raw.displayName),
      pointer: Boolean(raw.pointer),
      matchedMethods: Number(raw.matchedMethods),
      methodCount,
      confidence: raw.confidence === 'asserted' ? 'asserted' : 'structural',
      isTestDouble: Boolean(raw.isTestDouble),
    });
  }

  #verifiedDefinition(symbol: SymbolIdentity): RawDefinition | null {
    const result = this.#engine.resolve({
      project: this.source.repositoryKey,
      ref: this.source.commitSha,
      packagePath: dirname(symbol.path),
      path: symbol.path,
      line: symbol.line,
      character: symbol.column - 1,
      identifier: symbol.name,
    });
    if (result.status !== 'resolved') return null;
    const definition = result.definition as RawDefinition;
    return definition.kind === symbol.kind && definition.name === symbol.name ? definition : null;
  }

  #recordLimitations(files: readonly SourceFile[]): void {
    for (const file of files) {
      if (/^(?:\s*\/\/go:build\s+.+|\s*\/\/\s*\+build\s+.+)/m.test(file.source)) this.#buildConstrained.add(file.path);
      if (/\bimport\s+(?:\([^)]*?\n\s*)?\.\s*["`]/s.test(file.source)) this.#dotImported.add(file.path);
    }
  }

  #validateQuery(query: SemanticQuery): void {
    if (query.operation === 'resolve-symbol') {
      if (!Number.isInteger(query.line) || query.line < 1 || !Number.isInteger(query.column) || query.column < 1 || !query.identifier) {
        throw new IntelligenceContractError('Invalid resolve-symbol query.');
      }
      return;
    }
    pageSize(query.pageSize);
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}
