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
// hit), an element whose own trimmed text is exactly the identifier, or an
// element whose text contains the identifier as a whole word (GitLab's
// highlighter sometimes groups several tokens into one span, e.g.
// `hljs-params` wrapping an entire `(t *runAtTimerTask)` receiver, or a
// trailing span holding a method name plus its parens) — the guard that
// rejects a caret snapping from punctuation onto an adjacent identifier span.
export function caretElementMatchesIdentifier(element, cell, identifier) {
  if (!element || element === cell) return element === cell;
  const text = (element.textContent || '').trim();
  if (text === identifier) return true;
  const boundary = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}_])`, 'u');
  return boundary.test(text);
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

// groupLocationsByFile(locations) -> locations grouped by `path`, preserving
// first-appearance order (the worker's own sort order, already by path). No
// backend change needed: `path` is already on every findReferences() location.
export function groupLocationsByFile(locations) {
  const groups = [];
  const byPath = new Map();
  for (const location of locations || []) {
    let group = byPath.get(location.path);
    if (!group) {
      const parts = (location.path || '').split('/');
      const fileName = parts.pop() || location.path;
      group = { path: location.path, fileName, dirPath: parts.join('/'), locations: [] };
      byPath.set(location.path, group);
      groups.push(group);
    }
    group.locations.push(location);
  }
  return groups;
}

// --- signature syntax tokenizer -------------------------------------------
//
// tokenizeSignature(text) -> [{ text, cls }], cls one of tok-kw/tok-type/
// tok-builtin/tok-func/tok-param/tok-str/tok-num/tok-comment/tok-punct, or
// null for whitespace (rendered as a plain text node, no span). Scoped to
// exactly the grammar subset that appears in a Go function signature or
// struct body — not a general Go lexer/parser. Declared names (parameters,
// struct fields, the type's own name in `type X struct`) render in the base
// `tok-param` color regardless of case; only *referenced* types render
// `tok-type`, matching NOTES.md's documented popover convention.
//
// Heuristic: within a comma-separated parameter/return segment or a
// newline-separated struct-field line, the LAST whitespace-separated word is
// the type expression; any word(s) before it are declared names. A lone word
// (no leading name) is a bare type, e.g. a nameless return value.
const BUILTIN_TYPES = new Set([
  'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any',
]);

const LEX_PATTERN = /\/\/[^\n]*|"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*'|[\p{L}_][\p{L}\p{N}_]*|\d+(?:\.\d+)?|\s+|./gsu;

function lexSignature(text) {
  const tokens = [];
  for (const match of text.matchAll(LEX_PATTERN)) {
    const value = match[0];
    if (/^\s+$/.test(value)) tokens.push({ text: value, kind: 'ws' });
    else if (value.startsWith('//')) tokens.push({ text: value, kind: 'comment' });
    else if (/^["'`]/.test(value)) tokens.push({ text: value, kind: 'str' });
    else if (/^\d/.test(value)) tokens.push({ text: value, kind: 'num' });
    else if (/^[\p{L}_]/u.test(value)) tokens.push({ text: value, kind: 'ident' });
    else tokens.push({ text: value, kind: 'punct' });
  }
  return tokens;
}

function classifyTypeWord(word) {
  return word.map(({ text, kind }) => {
    if (kind !== 'ident') return { text, cls: 'tok-punct' };
    return { text, cls: BUILTIN_TYPES.has(text) ? 'tok-builtin' : 'tok-type' };
  });
}

function classifyNameWord(word) {
  return word.map(({ text, kind }) => ({ text, cls: kind === 'ident' ? 'tok-param' : 'tok-punct' }));
}

// classifySegment(tokens) -> classified tokens for one comma/newline-
// delimited segment (a single parameter, return value, or struct field).
// Splits the segment into whitespace-separated words: the last word is a
// type expression (tok-type/tok-builtin/tok-punct), any word(s) before it
// are declared names (tok-param). A segment with only one word is a bare
// type expression (e.g. an unnamed return value).
function classifySegment(tokens) {
  const words = [];
  let word = [];
  for (const token of tokens) {
    if (token.kind === 'ws') {
      if (word.length) words.push(word);
      word = [];
    } else {
      word.push(token);
    }
  }
  if (word.length) words.push(word);
  if (!words.length) return tokens.map(({ text }) => ({ text, cls: null }));
  const classifiedWords = words.map((w, index) => (index === words.length - 1 ? classifyTypeWord(w) : classifyNameWord(w)));
  const flatWords = classifiedWords.flat();
  let flatIndex = 0;
  const result = [];
  for (const token of tokens) {
    if (token.kind === 'ws') { result.push({ text: token.text, cls: null }); continue; }
    result.push(flatWords[flatIndex]);
    flatIndex++;
  }
  return result;
}

export function tokenizeSignature(text) {
  const raw = lexSignature(text || '');
  const out = [];
  let parenDepth = 0;
  let braceDepth = 0;
  const structBodyDepths = [];
  let expectFuncName = false;
  let expectDeclaredName = false;
  let pendingStructBrace = false;
  let segment = [];

  const flush = () => {
    if (!segment.length) return;
    out.push(...classifySegment(segment));
    segment = [];
  };

  for (const token of raw) {
    if (token.kind !== 'ws' && !(token.kind === 'punct' && token.text === '{')) pendingStructBrace = false;
    if (token.kind === 'comment') {
      flush();
      out.push({ text: token.text, cls: 'tok-comment' });
      continue;
    }
    if (token.kind === 'str') {
      flush();
      out.push({ text: token.text, cls: 'tok-str' });
      continue;
    }
    if (token.kind === 'num') {
      flush();
      out.push({ text: token.text, cls: 'tok-num' });
      continue;
    }
    if (token.kind === 'ident' && GO_KEYWORDS.has(token.text)) {
      flush();
      out.push({ text: token.text, cls: 'tok-kw' });
      if (token.text === 'func') expectFuncName = true;
      else if (token.text === 'type') expectDeclaredName = true;
      else if (token.text === 'struct') pendingStructBrace = true;
      continue;
    }
    if (token.kind === 'ident' && expectFuncName) {
      flush();
      out.push({ text: token.text, cls: 'tok-func' });
      expectFuncName = false;
      continue;
    }
    if (token.kind === 'ident' && expectDeclaredName) {
      flush();
      out.push({ text: token.text, cls: 'tok-param' });
      expectDeclaredName = false;
      continue;
    }
    if (token.kind === 'punct' && token.text === '(') {
      flush();
      parenDepth++;
      out.push({ text: '(', cls: 'tok-punct' });
      continue;
    }
    if (token.kind === 'punct' && token.text === ')') {
      flush();
      parenDepth = Math.max(0, parenDepth - 1);
      out.push({ text: ')', cls: 'tok-punct' });
      continue;
    }
    if (token.kind === 'punct' && token.text === ',' && parenDepth > 0) {
      flush();
      out.push({ text: ',', cls: 'tok-punct' });
      continue;
    }
    if (token.kind === 'punct' && token.text === '{') {
      flush();
      braceDepth++;
      if (pendingStructBrace) structBodyDepths.push(braceDepth);
      pendingStructBrace = false;
      out.push({ text: '{', cls: 'tok-punct' });
      continue;
    }
    if (token.kind === 'punct' && token.text === '}') {
      flush();
      if (structBodyDepths.at(-1) === braceDepth) structBodyDepths.pop();
      braceDepth = Math.max(0, braceDepth - 1);
      out.push({ text: '}', cls: 'tok-punct' });
      continue;
    }
    if (token.kind === 'ws' && token.text.includes('\n') && structBodyDepths.includes(braceDepth)) {
      flush();
      out.push({ text: token.text, cls: null });
      continue;
    }
    segment.push(token);
  }
  flush();
  return out;
}
