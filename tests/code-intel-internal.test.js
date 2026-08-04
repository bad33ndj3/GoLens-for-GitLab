import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import {
  isCodeCharacter,
  identifierAtCharacter,
  caretElementMatchesIdentifier,
  isWholeIdentifier,
  identifierBoundary,
  referenceNavigationAction,
  isInterfaceDeclaration,
  shouldShowReferencesOnHover,
  classify,
  symbolPresentation,
  implementationGroups,
  resultScopeText,
  absenceText,
  destinationLineForDefinition,
  locationKey,
  sourceLocationText,
  loadingPhaseLabel,
} from '../page/features/code-intel.internal.js';

test('does not resolve identifiers when the pointer is on call punctuation', () => {
  const source = 'target(value, other)';
  assert.deepEqual(identifierAtCharacter(source, source.indexOf('target')), { identifier: 'target', character: 0, occurrence: 0 });
  assert.equal(identifierAtCharacter(source, source.indexOf('(')), null);
  assert.equal(identifierAtCharacter(source, source.indexOf(',')), null);
  assert.equal(identifierAtCharacter(source, source.indexOf(')')), null);
});

test('numbers repeated rendered identifiers so source offsets cannot switch symbol roles', () => {
  const source = 'Foo := source.Foo; Foo()';
  const positions = [...source.matchAll(/Foo/g)].map((match) => match.index);
  assert.deepEqual(
    positions.map((character) => identifierAtCharacter(source, character)?.occurrence),
    [0, 1, 2],
  );
});

test('rejects caret hits that snap from punctuation to an adjacent identifier', () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.body.innerHTML = '<code><span class="operator">&amp;</span><span class="identifier">model</span><span class="operator">.</span><span class="identifier">ContractLabel</span></code>';
  const cell = window.document.querySelector('code');
  assert.equal(caretElementMatchesIdentifier(cell.querySelector('.operator'), cell, 'model'), false);
  assert.equal(caretElementMatchesIdentifier(cell.querySelector('.identifier'), cell, 'model'), true);
  assert.equal(caretElementMatchesIdentifier(cell, cell, 'model'), true);
});

test('does not resolve Go-looking text inside non-code tokens', () => {
  const source = 'target(*service, 42, "stringValue") // commentValue';
  assert.equal(identifierAtCharacter(source, source.indexOf('*')), null);
  assert.equal(identifierAtCharacter(source, source.indexOf('42')), null);
  assert.equal(identifierAtCharacter(source, source.indexOf('stringValue')), null);
  assert.equal(identifierAtCharacter(source, source.indexOf('commentValue')), null);
});

test('does not resolve Go language keywords', () => {
  assert.equal(identifierAtCharacter('func target() {}', 0), null);
  assert.equal(identifierAtCharacter('return target', 0), null);
});

test('isCodeCharacter treats comments, strings and rune literals as non-code', () => {
  assert.equal(isCodeCharacter('target // comment', 0), true);
  assert.equal(isCodeCharacter('target // comment', 10), false);
  assert.equal(isCodeCharacter('"quoted"', 3), false);
  assert.equal(isCodeCharacter("'r'", 1), false);
});

test('isWholeIdentifier accepts only a single Go-identifier-shaped token spanning the entire text', () => {
  assert.equal(isWholeIdentifier('Runner'), true);
  assert.equal(isWholeIdentifier('Runner()'), false);
  assert.equal(isWholeIdentifier(''), false);
  assert.equal(isWholeIdentifier(null), false);
});

test('identifierBoundary treats non-identifier characters and the empty string as legal boundaries', () => {
  assert.equal(identifierBoundary(''), true);
  assert.equal(identifierBoundary('.'), true);
  assert.equal(identifierBoundary('_'), false);
  assert.equal(identifierBoundary('a'), false);
});

test('opens a sole usage directly and shows a list for multiple usages', () => {
  assert.equal(referenceNavigationAction({ status: 'references', locations: [{}] }), 'open');
  assert.equal(referenceNavigationAction({ status: 'references', locations: [{}, {}] }), 'show');
});

test('formats concrete source locations for compact LLM context', () => {
  assert.equal(
    sourceLocationText({ path: 'svc/snapshot/pkg/search.go', line: 24, character: 7 }),
    'svc/snapshot/pkg/search.go:24:7',
  );
  assert.equal(sourceLocationText({ path: 'svc/snapshot/pkg/search.go', line: 24 }), '');
  assert.equal(sourceLocationText({ path: 'svc/snapshot/pkg/search.go', line: 0, character: 7 }), '');
});

test('shows usages rather than a definition preview when hovering a declaration', () => {
  assert.equal(shouldShowReferencesOnHover({ status: 'resolved', isDefinition: true }), true);
  assert.equal(shouldShowReferencesOnHover({ status: 'resolved', isDefinition: false }), false);
});

test('routes interface declarations to implementations without searching on hover', () => {
  const result = { status: 'resolved', isDefinition: true, definition: { kind: 'interface' } };
  assert.equal(isInterfaceDeclaration(result), true);
  assert.equal(shouldShowReferencesOnHover(result), false);
  assert.equal(isInterfaceDeclaration({ ...result, isDefinition: false }), false);
  assert.equal(isInterfaceDeclaration({ ...result, definition: { kind: 'type' } }), false);
});

test('groups production implementations ahead of collapsed test doubles', () => {
  const production = { displayName: 'service.Runner', isTestDouble: false };
  const mock = { displayName: '*mocks.Runner', isTestDouble: true };
  assert.deepEqual(
    implementationGroups({ status: 'implementations', candidates: [production, mock] }),
    { production: [production], testDoubles: [mock] },
  );
});

test('describes absence only within the proven semantic scope', () => {
  assert.equal(absenceText({ kind: 'currentPackage', packagePath: 'service', packageCount: 1 }), 'Not found in current package.');
  assert.equal(
    absenceText({ kind: 'indexedPackages', packageCount: 12, complete: false }),
    'Not found in 12 indexed packages. Search coverage is incomplete.',
  );
  assert.equal(
    absenceText({ kind: 'fullProject', packageCount: 40, complete: true }),
    'Full project searched; no result exists.',
  );
  assert.equal(
    resultScopeText({ kind: 'indexedPackages', packageCount: 12, complete: false }),
    '12 indexed packages · search coverage is incomplete',
  );
});

test('maps every Go symbol kind to a readable IDE-style badge', () => {
  const cases = {
    interface: ['I', 'Interface'],
    struct: ['S', 'Struct'],
    function: ['F', 'Function'],
    method: ['M', 'Method'],
    interfaceMethod: ['IM', 'Interface method'],
    type: ['T', 'Named type'],
    variable: ['V', 'Variable'],
    field: ['FD', 'Field'],
    constant: ['C', 'Constant'],
    parameter: ['P', 'Parameter'],
    package: ['PKG', 'Package'],
    builtin: ['F', 'Builtin function'],
    external: ['Go', 'External Go documentation'],
  };
  for (const [kind, [badge, label]] of Object.entries(cases)) {
    assert.deepEqual(
      { badge: symbolPresentation(kind).badge, label: symbolPresentation(kind).label },
      { badge, label },
    );
  }
  assert.deepEqual(
    { badge: symbolPresentation('nonsense').badge, label: symbolPresentation('nonsense').label },
    { badge: 'Go', label: 'External Go documentation' },
  );
});

test('opens documented declarations at their attached comment', () => {
  assert.equal(destinationLineForDefinition({ line: 12, documentationLine: 10 }), 10);
  assert.equal(destinationLineForDefinition({ line: 12, documentationLine: 0 }), 12);
});

test('locationKey builds a stable dedupe/comparison key, defaulting the side to "new"', () => {
  assert.equal(locationKey({ path: 'pkg/run.go', line: 2 }), 'pkg/run.go:2:new');
  assert.equal(locationKey({ path: 'pkg/run.go', line: 2, side: 'old' }), 'pkg/run.go:2:old');
  assert.equal(locationKey(null), '');
});

test('classify() maps every wire-level result status to its closed UI-outcome kind, with an explicit catch-all', () => {
  const cases = {
    resolved: 'resolved',
    standardLibrary: 'externalDoc',
    packageDocumentation: 'externalDoc',
    projectPackage: 'projectPackage',
    builtin: 'builtin',
    ambiguous: 'ambiguous',
    references: 'references',
    implementations: 'implementations',
    unsupportedImplementations: 'unsupportedImplementations',
    notFound: 'notFound',
    unsupported: 'unsupported',
  };
  for (const [status, kind] of Object.entries(cases)) assert.deepEqual(classify({ status }), { kind });
  assert.deepEqual(classify({ status: 'somethingUnknown' }), { kind: 'unrecognized' });
  assert.deepEqual(classify(null), { kind: 'unrecognized' });
});

test('loadingPhaseLabel captions every package-loading phase', () => {
  assert.equal(loadingPhaseLabel('discovering'), 'Preparing package');
  assert.equal(loadingPhaseLabel('indexing'), 'Indexing symbols');
  assert.equal(loadingPhaseLabel('fetching'), 'Loading source files');
});
