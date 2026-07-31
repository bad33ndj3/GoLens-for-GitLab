import assert from 'node:assert/strict';
import test from 'node:test';
import { Language, Parser } from 'web-tree-sitter';

import { commitSha, repositoryKey, repositoryPath, sourceIdentity } from '../../src/domain.ts';
import { SemanticSnapshotIndex, semanticQueryFingerprint } from '../../src/go-intelligence/semantic-index.ts';

const source = sourceIdentity({
  repositoryKey: repositoryKey('group/project'),
  commitSha: commitSha('a'.repeat(40)),
});
const code = `package sample

type Reader interface {
	Read([]byte) error
}

type File struct{}
func (File) Read([]byte) error { return nil }

func Target() {}
func Use() { Target(); Target() }
`;

async function parser() {
  await Parser.init();
  const value = new Parser();
  value.setLanguage(await Language.load(new URL('../../vendor/tree-sitter-go.wasm', import.meta.url).pathname));
  return value;
}

function coverage(complete) {
  return Object.freeze({
    scope: complete ? 'full-project' : 'current-package',
    complete,
    packageCount: 1,
    packagePaths: Object.freeze([repositoryPath('sample')]),
  });
}

async function snapshot(complete = true, revision = 'snapshot-1') {
  const value = new SemanticSnapshotIndex(await parser(), source, revision, coverage(complete));
  value.indexProject('example.com/project', [{ path: repositoryPath('sample/sample.go'), source: code }]);
  return value;
}

test('semantic outcomes carry source, snapshot, coverage, and complete type details', async () => {
  const index = await snapshot();
  const result = index.query({
    operation: 'resolve-symbol',
    path: repositoryPath('sample/sample.go'),
    line: 3,
    column: 6,
    identifier: 'Reader',
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.source, source);
  assert.equal(result.snapshot, 'snapshot-1');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.symbol.identity.kind, 'interface');
  assert.equal(result.symbol.fullTypeBody, 'type Reader interface {\n\tRead([]byte) error\n}');
});

test('missing is claimed only with complete coverage', async () => {
  const request = {
    operation: 'resolve-symbol',
    path: repositoryPath('sample/sample.go'),
    line: 11,
    column: 14,
    identifier: 'Absent',
  };
  assert.equal((await snapshot(false)).query(request).status, 'coverage-insufficient');
  assert.equal((await snapshot(true)).query(request).status, 'missing');

  const queryCoverage = (queryFingerprint) => Object.freeze({
    scope: 'complete-project-search', complete: true, packageCount: 1, packagePaths: Object.freeze(['sample']),
    queryFingerprint, searchStrategy: 'identifier',
  });
  const wrongSearch = new SemanticSnapshotIndex(await parser(), source, 'snapshot-1', queryCoverage('another-query'));
  wrongSearch.indexProject('example.com/project', [{ path: repositoryPath('sample/sample.go'), source: code }]);
  assert.equal(wrongSearch.query(request).status, 'coverage-insufficient');

  const matchingSearch = new SemanticSnapshotIndex(await parser(), source, 'snapshot-1', queryCoverage(semanticQueryFingerprint(request)));
  matchingSearch.indexProject('example.com/project', [{ path: repositoryPath('sample/sample.go'), source: code }]);
  assert.equal(matchingSearch.query(request).status, 'missing');
});

test('reference pages are stable, duplicate-free, and snapshot-bound', async () => {
  const index = await snapshot();
  const resolved = index.query({
    operation: 'resolve-symbol', path: repositoryPath('sample/sample.go'), line: 10, column: 6, identifier: 'Target',
  });
  assert.equal(resolved.status, 'resolved');

  const first = index.query({ operation: 'find-references', symbol: resolved.symbol.identity, pageSize: 1 });
  assert.equal(first.status, 'references');
  assert.deepEqual(first.locations.map(({ line, column }) => [line, column]), [[11, 14]]);
  assert.ok(first.nextPageToken);

  const second = index.query({
    operation: 'find-references', symbol: resolved.symbol.identity, pageSize: 1, pageToken: first.nextPageToken,
  });
  assert.equal(second.status, 'references');
  assert.deepEqual(second.locations.map(({ line, column }) => [line, column]), [[11, 24]]);

  const replaced = await snapshot(true, 'snapshot-2');
  assert.equal(replaced.query({
    operation: 'find-references', symbol: resolved.symbol.identity, pageSize: 1, pageToken: first.nextPageToken,
  }).status, 'stale-page');
});

test('ambiguous and unsupported queries remain explicit', async () => {
  const index = await snapshot();
  index.indexPackage('duplicates', [
    { path: repositoryPath('duplicates/use.go'), source: 'package duplicates\nfunc Use() { Shared() }\n' },
    { path: repositoryPath('duplicates/a.go'), source: 'package duplicates\nfunc Shared() {}\n' },
    { path: repositoryPath('duplicates/b.go'), source: 'package duplicates\nfunc Shared() {}\n' },
  ]);
  const ambiguous = index.query({
    operation: 'resolve-symbol', path: repositoryPath('duplicates/use.go'), line: 2, column: 14, identifier: 'Shared',
  });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.candidates.length, 2);

  index.indexPackage('constrained', [{
    path: repositoryPath('constrained/file.go'),
    source: '//go:build linux\n\npackage constrained\nfunc Target() {}\n',
  }]);
  assert.equal(index.query({
    operation: 'resolve-symbol', path: repositoryPath('constrained/file.go'), line: 4, column: 6, identifier: 'Target',
  }).status, 'unsupported');

  index.indexPackage('dot', [{
    path: repositoryPath('dot/file.go'), source: 'package dot\nimport . "fmt"\nfunc use() { Println("x") }\n',
  }]);
  const dotImport = index.query({
    operation: 'resolve-symbol', path: repositoryPath('dot/file.go'), line: 3, column: 14, identifier: 'Println',
  });
  assert.deepEqual({ status: dotImport.status, reason: dotImport.reason }, { status: 'unsupported', reason: 'dot-import' });

  const nestedPath = repositoryPath('nested/file.go');
  const singleRoot = new SemanticSnapshotIndex(await parser(), source, 'snapshot-1', coverage(true), new Set([nestedPath]));
  singleRoot.indexPackage('nested', [{ path: nestedPath, source: 'package nested\nfunc Target() {}\n' }]);
  const nested = singleRoot.query({ operation: 'resolve-symbol', path: nestedPath, line: 2, column: 6, identifier: 'Target' });
  assert.deepEqual({ status: nested.status, reason: nested.reason }, { status: 'unsupported', reason: 'single-root-module' });
});
