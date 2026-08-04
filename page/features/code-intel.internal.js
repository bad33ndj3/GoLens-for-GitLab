// page/features/code-intel.internal.js — pure decision core for
// page/features/code-intel.js. No DOM, no chrome.*, no timers, no fetch, no
// worker RPC: these functions only turn already-resolved data (a worker
// query result, a caret hit-test, a diff cell's text) into identifiers,
// classification, and presentation strings. Not part of the module's public
// interface — the dependency rules bar other modules from importing this
// file directly.

const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/u;
const GO_KEYWORDS = new Set(['break', 'default', 'func', 'interface', 'select', 'case', 'defer', 'go', 'map', 'struct', 'chan', 'else', 'goto', 'package', 'switch', 'const', 'fallthrough', 'if', 'range', 'type', 'continue', 'for', 'import', 'return', 'var']);

const SYMBOL_PRESENTATIONS = {
  interface: { badge: 'I', label: 'Interface', className: 'interface' },
  struct: { badge: 'S', label: 'Struct', className: 'struct' },
  function: { badge: 'F', label: 'Function', className: 'function' },
  method: { badge: 'M', label: 'Method', className: 'method' },
  interfaceMethod: { badge: 'IM', label: 'Interface method', className: 'interface-method' },
  type: { badge: 'T', label: 'Named type', className: 'type' },
  variable: { badge: 'V', label: 'Variable', className: 'variable' },
  field: { badge: 'FD', label: 'Field', className: 'field' },
  constant: { badge: 'C', label: 'Constant', className: 'constant' },
  parameter: { badge: 'P', label: 'Parameter', className: 'parameter' },
  package: { badge: 'PKG', label: 'Package', className: 'package' },
  builtin: { badge: 'F', label: 'Builtin function', className: 'function' },
  external: { badge: 'Go', label: 'External Go documentation', className: 'external' },
};

// isCodeCharacter(source, character) -> whether `character`'s offset in
// `source` sits inside actual Go code, not a comment/string/rune literal.
// Byte-identical to go-navigation.js's former isCodeCharacter(). Total.
export function isCodeCharacter(source, character) {
  let state = 'code';
  for (let index = 0; index <= character; index++) {
    const value = source[index] || '';
    const next = source[index + 1] || '';
    if (state === 'lineComment') return false;
    if (state === 'blockComment') {
      if (value === '*' && next === '/') {
        if (index === character || index + 1 === character) return false;
        state = 'code';
        index++;
        continue;
      }
      if (index === character) return false;
      continue;
    }
    if (state === 'string' || state === 'rune' || state === 'rawString') {
      if (index === character) return false;
      if (state !== 'rawString' && value === '\\') {
        if (index + 1 === character) return false;
        index++;
        continue;
      }
      if ((state === 'rawString' && value === '`') || (state === 'string' && value === '"') || (state === 'rune' && value === "'")) state = 'code';
      continue;
    }
    if (value === '/' && next === '/') {
      if (index === character || index + 1 === character) return false;
      state = 'lineComment';
      continue;
    }
    if (value === '/' && next === '*') {
      if (index === character || index + 1 === character) return false;
      state = 'blockComment';
      continue;
    }
    if (value === '"' || value === "'" || value === '`') {
      if (index === character) return false;
      state = value === '"' ? 'string' : value === "'" ? 'rune' : 'rawString';
      continue;
    }
    if (index === character) return true;
  }
  return false;
}

// identifierAtCharacter(source, character) -> the Go identifier spanning
// `character`'s offset, with its zero-based occurrence index among all
// code-position matches of the same identifier text in `source`, or `null`
// when the offset isn't a valid, in-code Go identifier. Byte-identical to
// go-navigation.js's former identifierAtCharacter(). Total.
export function identifierAtCharacter(source, character) {
  if (!isCodeCharacter(source, character)) return null;
  if (!/[\p{L}\p{N}_]/u.test(source[character] || '')) return null;
  let start = Math.min(character, source.length);
  let end = start;
  while (start > 0 && /[\p{L}\p{N}_]/u.test(source[start - 1])) start--;
  while (end < source.length && /[\p{L}\p{N}_]/u.test(source[end])) end++;
  const identifier = source.slice(start, end);
  if (!IDENTIFIER.test(identifier) || identifier !== identifier.match(IDENTIFIER)?.[0] || GO_KEYWORDS.has(identifier)) return null;
  let occurrence = 0;
  let candidate = source.indexOf(identifier);
  while (candidate >= 0 && candidate < start) {
    const before = source[candidate - 1] || '';
    const after = source[candidate + identifier.length] || '';
    if (!/[\p{L}\p{N}_]/u.test(before)
      && !/[\p{L}\p{N}_]/u.test(after)
      && isCodeCharacter(source, candidate)) occurrence++;
    candidate = source.indexOf(identifier, candidate + identifier.length);
  }
  return { identifier, character: start, occurrence };
}

// caretElementMatchesIdentifier(element, cell, identifier) -> whether a
// caret hit-test's DOM element is either the code cell itself (a bare-text
// hit) or an element whose own trimmed text is exactly the identifier — the
// guard that rejects a caret snapping from punctuation onto an adjacent
// identifier span. Byte-identical to go-navigation.js's former
// caretElementMatchesIdentifier(). Total.
export function caretElementMatchesIdentifier(element, cell, identifier) {
  if (!element || element === cell) return element === cell;
  return (element.textContent || '').trim() === identifier;
}

// isWholeIdentifier(text) -> whether `text` is, in its entirety, a single
// valid (non-keyword) Go identifier — the guard `identifierFromElement` uses
// to decide whether an element's trimmed text is itself an identifier span,
// pulled out of go-navigation.js's former inline
// `IDENTIFIER.test(identifier) && identifier === identifier.match(IDENTIFIER)?.[0]`.
// Total.
export function isWholeIdentifier(text) {
  return Boolean(text) && IDENTIFIER.test(text) && text === text.match(IDENTIFIER)?.[0];
}

// identifierBoundary(character) -> whether `character` (a single string
// character or '') is a legal Go-identifier boundary. Byte-identical to
// go-navigation.js's former identifierBoundary(). Total.
export function identifierBoundary(character) { return !character || !/[\p{L}\p{N}_]/u.test(character); }

// referenceNavigationAction(result) -> 'open' when a references result has
// exactly one, non-paginated location (jump straight there), else 'show'
// (render the choice list). Byte-identical to go-navigation.js's former
// referenceNavigationAction(). Total.
export function referenceNavigationAction(result) {
  return result.status === 'references' && result.locations.length === 1 && !result.hasMore ? 'open' : 'show';
}

// isInterfaceDeclaration(result) -> whether a resolveDefinition result landed
// on an interface's own declaration (routes semantic-jump to "find
// implementations" instead of "find usages"). Byte-identical to
// go-navigation.js's former isInterfaceDeclaration(). Total.
export function isInterfaceDeclaration(result) {
  return result.status === 'resolved' && result.isDefinition && result.definition.kind === 'interface';
}

// shouldShowReferencesOnHover(result) -> whether a hover resolution should
// escalate to a references search instead of showing the plain definition
// preview (non-interface declarations only — interfaces route to
// implementations elsewhere). Byte-identical to go-navigation.js's former
// shouldShowReferencesOnHover(). Total.
export function shouldShowReferencesOnHover(result) {
  return result.status === 'resolved' && result.isDefinition && result.definition?.kind !== 'interface';
}

// classify(result) -> { kind } — the closed, documented set of query-result
// outcomes `showResult()` branches on, pulled 1:1 out of its former 11-way
// `if/else if` chain on the worker's own wire-level `result.status`. The
// wire statuses are the query methods' own documented `kind` set and are NOT
// renamed here. This `kind` is the *UI-outcome* discriminator the shell's
// rendering dispatch switches on; `'unrecognized'` is the former chain's
// `else return false` catch-all — a closed set member like any other, never
// a guess, never a thrown exception.
export function classify(result) {
  switch (result?.status) {
    case 'resolved': return { kind: 'resolved' };
    case 'standardLibrary':
    case 'packageDocumentation': return { kind: 'externalDoc' };
    case 'projectPackage': return { kind: 'projectPackage' };
    case 'builtin': return { kind: 'builtin' };
    case 'ambiguous': return { kind: 'ambiguous' };
    case 'references': return { kind: 'references' };
    case 'implementations': return { kind: 'implementations' };
    case 'unsupportedImplementations': return { kind: 'unsupportedImplementations' };
    case 'notFound': return { kind: 'notFound' };
    case 'unsupported': return { kind: 'unsupported' };
    default: return { kind: 'unrecognized' };
  }
}

// symbolPresentation(kind) -> { badge, label, className } for a Go symbol
// kind, falling back to the generic "external" presentation for unknown
// kinds. Byte-identical to go-navigation.js's former symbolPresentation().
export function symbolPresentation(kind) {
  return SYMBOL_PRESENTATIONS[kind] || SYMBOL_PRESENTATIONS.external;
}

// implementationGroups(result) -> production vs. test-double candidates,
// production first. Byte-identical to go-navigation.js's former
// implementationGroups(). Total.
export function implementationGroups(result) {
  const candidates = result.status === 'implementations' ? result.candidates : [];
  return {
    production: candidates.filter((candidate) => !candidate.isTestDouble),
    testDoubles: candidates.filter((candidate) => candidate.isTestDouble),
  };
}

// resultScopeText(scope)/absenceText(scope) -> the popover's scope caption
// and not-found copy. Byte-identical to go-navigation.js's former
// resultScopeText()/absenceText(). Total.
export function resultScopeText(scope) {
  if (!scope) return '';
  if (scope.kind === 'fullProject') return `Full project · ${scope.packageCount} indexed package${scope.packageCount === 1 ? '' : 's'} · complete coverage`;
  if (scope.kind === 'completeProjectSearch') return `Complete project code search · ${scope.packageCount} indexed package${scope.packageCount === 1 ? '' : 's'}`;
  if (scope.kind === 'indexedPackages') return `${scope.packageCount} indexed package${scope.packageCount === 1 ? '' : 's'} · search coverage is incomplete`;
  return `Current package${scope.packagePath ? ` · ${scope.packagePath || '.'}` : ''}`;
}

export function absenceText(scope) {
  if (['completeProjectSearch', 'fullProject'].includes(scope?.kind) && scope.complete) return 'Full project searched; no result exists.';
  if (scope?.kind === 'indexedPackages') return `Not found in ${scope.packageCount} indexed packages. Search coverage is incomplete.`;
  return 'Not found in current package.';
}

// destinationLineForDefinition(definition) -> the line a "jump to
// definition" action should land on (the attached doc comment when present).
// Byte-identical to go-navigation.js's former destinationLineForDefinition().
export function destinationLineForDefinition(definition) {
  return definition.documentationLine || definition.line;
}

// locationKey(location) -> a stable dedupe/comparison key for a source
// location. Byte-identical to go-navigation.js's former locationKey().
export function locationKey(location) {
  return location ? `${location.path}:${location.line}:${location.side || 'new'}` : '';
}

// sourceLocationText(sourceLocation) -> the compact "path:line:character"
// copy-to-clipboard text, or '' when the location is incomplete. Byte-
// identical to go-navigation.js's former sourceLocationText(). Total.
export function sourceLocationText(sourceLocation) {
  if (!sourceLocation?.path || !Number.isInteger(sourceLocation.line) || !Number.isInteger(sourceLocation.character)) return '';
  if (sourceLocation.line < 1 || sourceLocation.character < 1) return '';
  return `${sourceLocation.path}:${sourceLocation.line}:${sourceLocation.character}`;
}

// loadingPhaseLabel(phase) -> the loading-progress panel's phase caption.
// Byte-identical to go-navigation.js's former loadingPhaseLabel().
export function loadingPhaseLabel(phase) {
  if (phase === 'discovering') return 'Preparing package';
  if (phase === 'indexing') return 'Indexing symbols';
  return 'Loading source files';
}
