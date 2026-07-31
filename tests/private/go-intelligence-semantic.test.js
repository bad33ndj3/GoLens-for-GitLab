import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { Language, Parser } from 'web-tree-sitter';

import { commitSha, repositoryKey, repositoryPath, sourceIdentity } from '../../src/domain.ts';
import { SemanticSnapshotIndex } from '../../src/go-intelligence/semantic-index.ts';

const fixtures = fileURLToPath(new URL('../fixtures/semantic-regressions/', import.meta.url));
const source = sourceIdentity({ repositoryKey: repositoryKey('semantic-regressions'), commitSha: commitSha('b'.repeat(40)) });
const coverage = Object.freeze({ scope: 'full-project', complete: true, packageCount: 8, packagePaths: Object.freeze([]) });
let goParser;

before(async () => {
  await Parser.init();
  goParser = new Parser();
  goParser.setLanguage(await Language.load(new URL('../../vendor/tree-sitter-go.wasm', import.meta.url).pathname));
});

function fixtureFiles(name) {
  const root = join(fixtures, name);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.go'))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path: repositoryPath(relative(root, path)), source: readFileSync(path, 'utf8') };
    });
}

function snapshot(files) {
  const index = new SemanticSnapshotIndex(goParser, source, 'regressions', coverage);
  index.indexProject('example.com/project', files);
  return index;
}

function position(text, line, identifier) {
  const column = text.split('\n')[line - 1].indexOf(identifier) + 1;
  assert.ok(column > 0);
  return { line, column, identifier };
}

function resolve(index, file, line, identifier) {
  return index.query({ operation: 'resolve-symbol', path: file.path, ...position(file.source, line, identifier) });
}

test('preserves pointer, value, promoted, and embedded method sets', () => {
  for (const [fixture, interfaceName, expected] of [
    ['pointer-value', 'Runner', ['*service.PointerRunner', 'service.ValueRunner']],
    ['promoted-methods', 'Runner', ['*service.Base', 'service.EmbeddedPointer']],
    ['embedded-interfaces', 'ReadCloser', ['contracts.Service']],
  ]) {
    const files = fixtureFiles(fixture);
    const index = snapshot(files);
    const contract = files.find(({ path }) => path.includes('contracts'));
    const line = contract.source.split('\n').findIndex((value) => value.includes(`${interfaceName} interface`)) + 1;
    const result = resolve(index, contract, line, interfaceName);
    assert.equal(result.status, 'resolved');
    const implementations = index.query({ operation: 'find-implementations', symbol: result.symbol.identity });
    assert.equal(implementations.status, 'implementations');
    assert.deepEqual(implementations.candidates.map(({ displayName }) => displayName), expected);
  }
});

test('preserves aliases, generic receivers, external test packages, and mocks', () => {
  const aliasFiles = fixtureFiles('aliases-generics');
  const alias = resolve(snapshot(aliasFiles), aliasFiles[0], 7, 'Get');
  assert.equal(alias.status, 'resolved');
  assert.equal(alias.symbol.receiver, 'Box');

  const generatedFiles = fixtureFiles('generated-external-tests');
  const index = snapshot(generatedFiles);
  const contract = generatedFiles.find(({ path }) => path === 'contracts/contracts.go');
  const runner = resolve(index, contract, 3, 'Runner');
  assert.equal(runner.status, 'resolved');
  const implementations = index.query({ operation: 'find-implementations', symbol: runner.symbol.identity });
  assert.equal(implementations.status, 'implementations');
  assert.deepEqual(implementations.candidates.map(({ displayName, isTestDouble }) => ({ displayName, isTestDouble })), [
    { displayName: 'contracts_test.ExternalRunner', isTestDouble: true },
    { displayName: '*mocks.GeneratedRunner', isTestDouble: true },
  ]);
});

test('keeps build constraints unsupported and converts UTF-16 columns correctly', () => {
  const constrained = fixtureFiles('build-constraints');
  assert.equal(resolve(snapshot(constrained), constrained[0], 5, 'Runner').status, 'unsupported');

  const unicode = `package unicode

func Target() {}
func use() { π := "é"; _ = π; Target() }
`;
  const file = { path: repositoryPath('unicode/main.go'), source: unicode };
  const index = snapshot([file]);
  const target = resolve(index, file, 3, 'Target');
  assert.equal(target.status, 'resolved');
  const references = index.query({ operation: 'find-references', symbol: target.symbol.identity });
  assert.equal(references.status, 'references');
  assert.deepEqual(references.locations.map(({ line, column }) => [line, column]), [[4, 31]]);
});

test('preserves lexical scope and rendered occurrence roles', () => {
  const scoped = `package scoped

func Target() {}
func use() { Target := Target; _ = Target }
`;
  const file = { path: repositoryPath('scoped/main.go'), source: scoped };
  const index = snapshot([file]);
  const query = (occurrence) => index.query({
    operation: 'resolve-symbol', path: file.path, line: 4, column: 1, identifier: 'Target', occurrence,
  });
  const declaration = query(0);
  const initializer = query(1);
  const usage = query(2);
  assert.equal(declaration.status, 'resolved');
  assert.equal(initializer.status, 'resolved');
  assert.equal(usage.status, 'resolved');
  assert.equal(declaration.symbol.identity.kind, 'variable');
  assert.equal(initializer.symbol.identity.kind, 'function');
  assert.deepEqual(usage.symbol.identity, declaration.symbol.identity);
});
