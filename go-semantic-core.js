const IDENTIFIER_TYPES = new Set(['identifier', 'field_identifier', 'package_identifier', 'type_identifier']);
const PREDECLARED_FUNCTIONS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make',
  'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover',
]);
const PREDECLARED_TYPES = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32',
  'uint64', 'uintptr',
]);
const COMPACT_SIGNATURE_LIMIT = 160;

function packageKey(origin, project, ref, packagePath) {
  return `${origin}\u0000${project}\u0000${ref}\u0000${packagePath}`;
}

function projectKey(origin, project, ref) {
  return `${origin}\u0000${project}\u0000${ref}`;
}

function fileKey(origin, project, ref, path) {
  return `${origin}\u0000${project}\u0000${ref}\u0000${path}`;
}

function textOf(source, node) {
  return node ? source.slice(node.startIndex, node.endIndex) : '';
}

function unquoteImport(value) {
  if (value.startsWith('`') && value.endsWith('`')) return value.slice(1, -1);
  try { return JSON.parse(value); } catch { return value.replace(/^"|"$/g, ''); }
}

function isStandardLibraryImport(importPath) {
  return Boolean(importPath) && !importPath.split('/')[0].includes('.');
}

function externalImportResult(importPath, symbol) {
  if (isStandardLibraryImport(importPath)) return { status: 'standardLibrary', importPath, symbol };
  return { status: 'packageDocumentation', importPath, symbol };
}

function defaultImportName(importPath) {
  const parts = importPath.split('/').filter(Boolean);
  const last = parts.at(-1) || '';
  return /^v[2-9]\d*$/.test(last) && parts.length > 1 ? parts.at(-2) : last;
}

function receiverType(value) {
  return value
    .replace(/\s+/g, '')
    .replace(/^\(+|\)+$/g, '')
    .replace(/^\*+/, '')
    .replace(/\[.*\]$/, '')
    .split('.')
    .pop();
}

function dirname(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function projectTypeIdentity(file, name) {
  const packageImportPath = [file.modulePath, file.packagePath].filter(Boolean).join('/');
  const testPackage = file.packageName?.endsWith('_test') ? `#${file.packageName}` : '';
  return `${packageImportPath || file.packagePath}${testPackage}.${name}`;
}

function namedTypeIdentity(file, value) {
  const parts = value.split('.');
  const name = parts.pop();
  if (!name) return '';
  if (parts.length) {
    const importPath = file.imports.get(parts.join('.'));
    return importPath ? `${importPath}.${name}` : value;
  }
  return PREDECLARED_TYPES.has(name) ? `builtin.${name}` : projectTypeIdentity(file, name);
}

function typeIdentity(file, node) {
  if (!node) return '';
  if (node.type === 'type_identifier' || node.type === 'identifier') return namedTypeIdentity(file, textOf(file.source, node));
  if (node.type === 'qualified_type') {
    const packageName = textOf(file.source, node.childForFieldName('package'));
    const name = textOf(file.source, node.childForFieldName('name'));
    const importPath = file.imports.get(packageName);
    return importPath ? `${importPath}.${name}` : `${packageName}.${name}`;
  }
  if (node.type === 'function_type') {
    const parameters = parameterTypes(file, node.childForFieldName('parameters'));
    const results = resultTypes(file, node.childForFieldName('result'));
    return `func(${parameters.join(',')})(${results.join(',')})`;
  }
  if (node.type === 'channel_type') {
    const source = textOf(file.source, node).trim();
    const direction = source.startsWith('<-chan') ? '<-chan' : source.startsWith('chan<-') ? 'chan<-' : 'chan';
    return `${direction}(${typeIdentity(file, node.childForFieldName('value'))})`;
  }
  const children = node.namedChildren.map((child) => typeIdentity(file, child) || textOf(file.source, child).replace(/\s+/g, ''));
  return `${node.type}(${children.join(',')})`;
}

function parameterTypes(file, parameterList) {
  const types = [];
  for (const parameter of parameterList?.namedChildren || []) {
    if (parameter.type !== 'parameter_declaration' && parameter.type !== 'variadic_parameter_declaration') continue;
    const typeNode = parameter.childForFieldName('type');
    const identity = `${parameter.type === 'variadic_parameter_declaration' ? '...' : ''}${typeIdentity(file, typeNode)}`;
    const names = parameter.namedChildren.filter((child) => child.id !== typeNode?.id && IDENTIFIER_TYPES.has(child.type));
    for (let index = 0; index < Math.max(1, names.length); index++) types.push(identity);
  }
  return types;
}

function resultTypes(file, result) {
  if (!result) return [];
  if (result.type === 'parameter_list') return parameterTypes(file, result);
  return [typeIdentity(file, result)];
}

function methodIdentity(file, node) {
  const name = textOf(file.source, node.childForFieldName('name'));
  const parameters = parameterTypes(file, node.childForFieldName('parameters'));
  const results = resultTypes(file, node.childForFieldName('result'));
  return `${name}(${parameters.join(',')})(${results.join(',')})`;
}

function receiverDetails(source, receiver) {
  const parameter = receiver?.namedChildren.find((child) => child.type === 'parameter_declaration');
  const typeNode = parameter?.childForFieldName('type');
  return {
    name: textOf(source, firstIdentifier(typeNode)),
    pointer: typeNode?.type === 'pointer_type',
  };
}

function testDoublePath(path) {
  if (/_test\.go$/i.test(path)) return true;
  return path.split('/').some((part) => /^(?:mocks?|fakes?|stubs?|testdoubles?)$/i.test(part));
}

function assertionFor(file, node) {
  const source = textOf(file.source, node).replace(/\s+/g, ' ').trim();
  const match = source.match(/^_\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*=\s*(?:(?:\(\s*\*\s*)|&\s*)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/);
  if (!match) return null;
  return {
    interfaceIdentity: namedTypeIdentity(file, match[1]),
    typeIdentity: namedTypeIdentity(file, match[2]),
  };
}

function declarationDocumentation(source, node) {
  const comments = [];
  let previous = node.previousNamedSibling;
  let expectedRow = node.startPosition.row - 1;
  while (previous?.type === 'comment' && previous.endPosition.row === expectedRow) {
    comments.unshift(previous);
    expectedRow = previous.startPosition.row - 1;
    previous = previous.previousNamedSibling;
  }
  return {
    line: comments[0]?.startPosition.row + 1 || 0,
    text: comments.map((comment) => textOf(source, comment)).join('\n')
    .replace(/^\s*\/\/\s?/gm, '')
    .replace(/^\s*\/\*+\s?/, '')
    .replace(/\s*\*\/$/, '')
    .replace(/^\s*\*\s?/gm, '')
    .trim(),
  };
}

function signatureFor(source, node) {
  const body = node.childForFieldName?.('body');
  if (body) return source.slice(node.startIndex, body.startIndex).trim().replace(/\s+/g, ' ');
  return textOf(source, node).split('\n')[0].trim();
}

function parameterCount(parameter) {
  const typeNode = parameter.childForFieldName?.('type');
  const names = parameter.namedChildren.filter((child) => child.id !== typeNode?.id && IDENTIFIER_TYPES.has(child.type));
  return Math.max(1, names.length);
}

function compactSignatureFor(source, node, signature) {
  if (signature.length <= COMPACT_SIGNATURE_LIMIT) return '';
  const parameters = node.childForFieldName?.('parameters');
  if (!parameters) return '';
  const entries = parameters.namedChildren
    .filter((child) => child.type === 'parameter_declaration' || child.type === 'variadic_parameter_declaration')
    .map((child) => ({ text: textOf(source, child).replace(/\s+/g, ' '), count: parameterCount(child) }));
  if (!entries.length) return '';

  const body = node.childForFieldName?.('body');
  const prefix = source.slice(node.startIndex, parameters.startIndex).trim().replace(/\s+/g, ' ');
  const suffix = source.slice(parameters.endIndex, body?.startIndex ?? node.endIndex).trim().replace(/\s+/g, ' ');
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const visible = [];
  let visibleCount = 0;
  for (const entry of entries) {
    const nextCount = visibleCount + entry.count;
    const remaining = total - nextCount;
    const middle = [...visible, entry.text, ...(remaining ? [`… +${remaining} parameters`] : [])].join(', ');
    const candidate = `${prefix}(${middle})${suffix ? ` ${suffix}` : ''}`;
    if (candidate.length > COMPACT_SIGNATURE_LIMIT && visible.length) break;
    if (candidate.length > COMPACT_SIGNATURE_LIMIT && !visible.length) break;
    visible.push(entry.text);
    visibleCount = nextCount;
  }
  const remaining = total - visibleCount;
  if (!remaining) return '';
  const middle = [...visible, `… +${remaining} parameters`].join(', ');
  return `${prefix}(${middle})${suffix ? ` ${suffix}` : ''}`;
}

function documentationNodeFor(source, node) {
  if (node.parent?.type === 'type_declaration') return node.parent;
  if (node.type !== 'var_spec' && node.type !== 'const_spec') return node;
  const declaration = node.parent;
  const specifications = declaration?.namedChildren.filter((child) => child.type === node.type) || [];
  const grouped = /^(?:var|const)\s*\(/.test(textOf(source, declaration).trimStart());
  return specifications.length === 1 && !grouped ? declaration : node;
}

function definitionFor({ source, node, nameNode, kind, receiver = '', packageName, packagePath, path, ref }) {
  const documentation = declarationDocumentation(source, documentationNodeFor(source, node));
  const signature = signatureFor(source, node);
  const compactSignature = compactSignatureFor(source, node, signature);
  return {
    name: textOf(source, nameNode),
    kind,
    receiver: receiverType(receiver),
    signature,
    ...(compactSignature ? { compactSignature } : {}),
    documentation: documentation.text,
    documentationLine: documentation.line,
    packageName,
    packagePath,
    path,
    ref,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
  };
}

function definitionLocationKey(definition) {
  return `${definition.path}\u0000${definition.line}\u0000${definition.column}`;
}

function uniqueDefinitions(definitions) {
  const unique = new Map();
  definitions.forEach((definition) => unique.set(`${definitionLocationKey(definition)}\u0000${definition.kind}`, definition));
  return [...unique.values()].sort((left, right) => (
    `${left.kind}\u0000${left.receiver}\u0000${left.path}\u0000${String(left.line).padStart(8, '0')}\u0000${String(left.column).padStart(8, '0')}`
      .localeCompare(`${right.kind}\u0000${right.receiver}\u0000${right.path}\u0000${String(right.line).padStart(8, '0')}\u0000${String(right.column).padStart(8, '0')}`)
  ));
}

function sameDefinition(left, right) {
  return left?.path === right?.path
    && left?.ref === right?.ref
    && left?.line === right?.line
    && left?.column === right?.column
    && left?.kind === right?.kind
    && left?.name === right?.name;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

function firstIdentifier(node) {
  if (!node) return null;
  if (IDENTIFIER_TYPES.has(node.type)) return node;
  for (const child of node.namedChildren) {
    const found = firstIdentifier(child);
    if (found) return found;
  }
  return null;
}

function namedIdentifiers(node) {
  if (!node) return [];
  if (IDENTIFIER_TYPES.has(node.type)) return [node];
  return node.namedChildren.filter((child) => IDENTIFIER_TYPES.has(child.type));
}

function isKeyedElementKey(identifierNode) {
  let node = identifierNode.parent;
  while (node && node.type !== 'keyed_element') node = node.parent;
  const key = node?.childForFieldName?.('key');
  return Boolean(key && key.startIndex <= identifierNode.startIndex && key.endIndex >= identifierNode.endIndex);
}

function containsNode(scope, node) {
  return scope.startIndex <= node.startIndex && scope.endIndex >= node.endIndex;
}

function lexicalScopeFor(node, functionNode) {
  const scopeTypes = new Set([
    'block', 'if_statement', 'for_statement', 'expression_switch_statement',
    'type_switch_statement', 'select_statement', 'expression_case', 'type_case', 'communication_case',
  ]);
  let current = node.parent;
  while (current && current.id !== functionNode.id) {
    if (scopeTypes.has(current.type)) return current;
    current = current.parent;
  }
  return functionNode;
}

function localDefinitionFor(file, identifierNode, name) {
  if (identifierNode.type !== 'identifier' || name === '_' || isKeyedElementKey(identifierNode)) return null;
  let functionNode = identifierNode.parent;
  while (functionNode && !['function_declaration', 'method_declaration', 'func_literal'].includes(functionNode.type)) functionNode = functionNode.parent;
  if (!functionNode) return null;

  const definitions = [];
  const add = (declaration, nameNode, kind = 'variable', scope = functionNode, visibleAfter = declaration.endIndex, mayRedeclare = false) => {
    if (!nameNode || textOf(file.source, nameNode) !== name || !containsNode(scope, identifierNode)) return;
    const isDeclaration = nameNode.id === identifierNode.id;
    if (!isDeclaration && (nameNode.startIndex > identifierNode.startIndex || identifierNode.startIndex < visibleAfter)) return;
    const body = functionNode.childForFieldName?.('body');
    const scopeID = scope.id === body?.id ? functionNode.id : scope.id;
    if (mayRedeclare && definitions.some((candidate) => candidate.scopeID === scopeID)) return;
    definitions.push({ offset: nameNode.startIndex, scopeID, definition: definitionFor({
      source: file.source,
      node: declaration,
      nameNode,
      kind,
      packageName: file.packageName,
      packagePath: file.packagePath,
      path: file.path,
      ref: file.ref,
    }) });
  };

  const addParameters = (parameters) => {
    for (const parameter of parameters?.namedChildren || []) {
      if (parameter.type !== 'parameter_declaration') continue;
      parameter.namedChildren
        .filter((child) => child.type === 'identifier')
        .forEach((nameNode) => add(
          parameter,
          nameNode,
          'parameter',
          functionNode,
          functionNode.childForFieldName?.('body')?.startIndex ?? functionNode.endIndex,
        ));
    }
  };
  addParameters(functionNode.childForFieldName?.('parameters'));
  addParameters(functionNode.childForFieldName?.('receiver'));

  walk(functionNode.childForFieldName?.('body') || functionNode, (node) => {
    const scope = lexicalScopeFor(node, functionNode);
    if (node.type === 'short_var_declaration') {
      namedIdentifiers(node.childForFieldName('left')).forEach((nameNode) => add(node, nameNode, 'variable', scope, node.endIndex, true));
    }
    if (node.type === 'var_spec' || node.type === 'const_spec') {
      namedIdentifiers(node.childForFieldName('name') || node).forEach((nameNode) => add(node, nameNode, node.type === 'const_spec' ? 'constant' : 'variable', scope));
    }
    if (node.type === 'range_clause') {
      const declares = node.children.some((child) => textOf(file.source, child) === ':=');
      if (declares) namedIdentifiers(node.childForFieldName('left')).forEach((nameNode) => add(node, nameNode, 'variable', scope, node.endIndex, true));
    }
  });

  return definitions.sort((left, right) => right.offset - left.offset)[0]?.definition || null;
}

function utf8Column(line, character) {
  return new TextEncoder().encode(line.slice(0, Math.max(0, character))).length;
}

function utf16Column(line, byteColumn) {
  const encoder = new TextEncoder();
  let bytes = 0;
  let character = 0;
  for (const value of line) {
    if (bytes >= byteColumn) break;
    bytes += encoder.encode(value).length;
    character += value.length;
  }
  return character;
}

function findIdentifierNode(root, source, line, character, fallbackIdentifier = '', occurrence = null, lines = source.split('\n')) {
  const row = Math.max(0, Math.min(line - 1, lines.length - 1));
  const sourceLine = lines[row] || '';
  if (Number.isInteger(occurrence) && occurrence >= 0 && fallbackIdentifier) {
    const identifiers = [];
    walk(root, (candidate) => {
      if (IDENTIFIER_TYPES.has(candidate.type)
        && candidate.startPosition.row === row
        && textOf(source, candidate) === fallbackIdentifier) identifiers.push(candidate);
    });
    identifiers.sort((left, right) => left.startIndex - right.startIndex);
    return identifiers[occurrence] || null;
  }
  const column = utf8Column(sourceLine, character);
  let node = root.descendantForPosition({ row, column });
  while (node && !IDENTIFIER_TYPES.has(node.type)) node = node.parent;
  if (node && (!fallbackIdentifier || textOf(source, node) === fallbackIdentifier)) return node;

  if (!fallbackIdentifier) return null;
  const precedingSource = row ? `${lines.slice(0, row).join('\n')}\n` : '';
  const lineStart = new TextEncoder().encode(precedingSource).length;
  const candidates = [];
  let candidate = sourceLine.indexOf(fallbackIdentifier);
  while (candidate >= 0) {
    const before = sourceLine[candidate - 1] || '';
    const after = sourceLine[candidate + fallbackIdentifier.length] || '';
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) candidates.push(candidate);
    candidate = sourceLine.indexOf(fallbackIdentifier, candidate + fallbackIdentifier.length);
  }
  const localIndex = candidates.sort((a, b) => Math.abs(a - character) - Math.abs(b - character))[0] ?? -1;
  if (localIndex < 0) return null;
  const index = lineStart + utf8Column(sourceLine, localIndex);
  const endIndex = index + new TextEncoder().encode(fallbackIdentifier).length;
  let fallback = root.descendantForIndex(index, endIndex);
  while (fallback && !IDENTIFIER_TYPES.has(fallback.type)) fallback = fallback.parent;
  return fallback;
}

function fileLines(file) {
  if (!file.lines) file.lines = file.source.split('\n');
  return file.lines;
}

function explicitBindingType(source, identifierNode, name) {
  let scope = identifierNode;
  while (scope && !['function_declaration', 'method_declaration', 'func_literal', 'source_file'].includes(scope.type)) scope = scope.parent;
  if (!scope) return '';

  if (scope.type === 'method_declaration') {
    const receiver = scope.childForFieldName('receiver');
    const binding = receiver?.namedChildren.find((child) => child.type === 'parameter_declaration');
    const bindingName = binding?.childForFieldName('name');
    if (textOf(source, bindingName) === name) return receiverType(textOf(source, binding.childForFieldName('type')));
  }

  const parameters = scope.childForFieldName?.('parameters');
  for (const parameter of parameters?.namedChildren || []) {
    if (parameter.type !== 'parameter_declaration') continue;
    const names = parameter.namedChildren.filter((child) => child.type === 'identifier');
    if (names.some((candidate) => textOf(source, candidate) === name)) {
      return receiverType(textOf(source, parameter.childForFieldName('type')));
    }
  }

  let inferred = '';
  walk(scope, (node) => {
    if (inferred) return;
    if (node.type === 'var_spec') {
      const names = namedIdentifiers(node);
      if (names.some((candidate) => textOf(source, candidate) === name)) {
        inferred = receiverType(textOf(source, node.childForFieldName('type')));
      }
    }
    if (node.type === 'short_var_declaration') {
      const left = node.childForFieldName('left');
      if (!left || !namedIdentifiers(left).some((candidate) => textOf(source, candidate) === name)) return;
      const right = node.childForFieldName('right');
      const composite = right?.namedChildren.find((child) => ['composite_literal', 'unary_expression'].includes(child.type));
      inferred = receiverType(textOf(source, composite?.childForFieldName?.('type') || firstIdentifier(composite)));
    }
  });
  return inferred;
}

function typeForExpression(entry, file, identifierNode, expression) {
  if (!expression) return '';
  if (expression.type === 'identifier') {
    return explicitBindingType(file.source, identifierNode, textOf(file.source, expression));
  }
  if (expression.type !== 'selector_expression') return '';
  const receiver = typeForExpression(entry, file, identifierNode, expression.childForFieldName('operand'));
  const field = textOf(file.source, expression.childForFieldName('field'));
  return entry.types.get(receiver)?.fields.get(field)?.type || '';
}

function shadowsPredeclaredFunction(file, identifierNode, name) {
  return file.imports.has(name) || Boolean(localDefinitionFor(file, identifierNode, name));
}

function packageDefinitions(entry, name, packageName = entry.packageName) {
  return (entry.definitions.get(name) || []).filter((definition) => definition.packageName === packageName);
}

function memberDefinitions(entry, name, receiver = '', packageName = entry.packageName) {
  const members = entry.members.get(name) || [];
  return members.filter((definition) => (
    definition.packageName === packageName && (!receiver || definition.receiver === receiver)
  ));
}

function compositeLiteralType(file, identifierNode) {
  let literal = identifierNode.parent;
  while (literal && literal.type !== 'composite_literal') literal = literal.parent;
  const typeNode = literal?.childForFieldName?.('type');
  if (!typeNode) return null;
  if (typeNode.type === 'qualified_type') {
    return {
      qualifier: textOf(file.source, typeNode.childForFieldName('package')),
      name: textOf(file.source, typeNode.childForFieldName('name')),
    };
  }
  const nameNode = firstIdentifier(typeNode);
  return nameNode ? { qualifier: '', name: textOf(file.source, nameNode) } : null;
}

export class GoSemanticIndex {
  constructor(parser) {
    this.parser = parser;
    this.packages = new Map();
    this.files = new Map();
    this.projects = new Set();
  }

  hasPackage({ origin = '', project, ref, packagePath }) {
    return this.packages.has(packageKey(origin, project, ref, packagePath));
  }

  hasProject({ origin = '', project, ref }) {
    return this.projects.has(projectKey(origin, project, ref));
  }

  clear() {
    this.packages.clear();
    this.files.clear();
    this.projects.clear();
  }

  indexPackage({ origin = '', project, ref, packagePath, modulePath = '', files }) {
    const key = packageKey(origin, project, ref, packagePath);
    const previous = this.packages.get(key);
    for (const path of previous?.files.keys() || []) this.files.delete(fileKey(origin, project, ref, path));
    const entry = {
      origin,
      project,
      ref,
      packagePath,
      modulePath,
      packageName: '',
      definitions: new Map(),
      members: new Map(),
      definitionsByLocation: new Map(),
      types: new Map(),
      typeRecords: [],
      methods: [],
      assertions: [],
      files: new Map(),
    };

    for (const file of files) {
      const tree = this.parser.parse(file.source);
      const fileEntry = { ...file, origin, ref, project, packagePath, modulePath, tree, imports: new Map(), importPaths: new Set(), lines: null };
      const packageClause = tree.rootNode.namedChildren.find((node) => node.type === 'package_clause');
      const packageNameNode = firstIdentifier(packageClause);
      const packageName = textOf(file.source, packageNameNode);
      fileEntry.packageName = packageName;
      if (packageName && (!entry.packageName || (entry.packageName.endsWith('_test') && !packageName.endsWith('_test')))) {
        entry.packageName = packageName;
      }

      const recordDefinition = (definition, packageScoped = true) => {
        if (!definition?.name) return definition;
        entry.definitionsByLocation.set(definitionLocationKey(definition), definition);
        const collection = packageScoped ? entry.definitions : entry.members;
        const existing = collection.get(definition.name) || [];
        existing.push(definition);
        collection.set(definition.name, existing);
        return definition;
      };

      walk(tree.rootNode, (node) => {
        if (node.type === 'import_spec') {
          const pathNode = node.childForFieldName('path');
          const importPath = unquoteImport(textOf(file.source, pathNode));
          const aliasNode = node.childForFieldName('name');
          const alias = textOf(file.source, aliasNode) || defaultImportName(importPath);
          if (importPath) fileEntry.importPaths.add(importPath);
          if (alias && alias !== '_' && alias !== '.') fileEntry.imports.set(alias, importPath);
          return;
        }

        const add = (nameNode, kind, receiver = '', packageScoped = true) => {
          if (!nameNode) return;
          const definition = definitionFor({
            source: file.source,
            node,
            nameNode,
            kind,
            receiver,
            packageName,
            packagePath,
            path: file.path,
            ref,
          });
          return recordDefinition(definition, packageScoped);
        };

        if (node.type === 'function_declaration') add(node.childForFieldName('name'), 'function');
        if (node.type === 'method_declaration') {
          const receiver = node.childForFieldName('receiver');
          const receiverInfo = receiverDetails(file.source, receiver);
          const definition = add(node.childForFieldName('name'), 'method', receiverInfo.name, false);
          if (definition && receiverInfo.name) {
            entry.methods.push({
              definition,
              receiver: receiverInfo.name,
              receiverIdentity: projectTypeIdentity(fileEntry, receiverInfo.name),
              pointer: receiverInfo.pointer,
              identity: methodIdentity(fileEntry, node),
            });
          }
        }
        if (node.type === 'type_spec') {
          const nameNode = node.childForFieldName('name');
          const typeNode = node.childForFieldName('type');
          const typeName = textOf(file.source, nameNode);
          const fields = new Map();
          if (typeNode?.type === 'struct_type') {
            walk(typeNode, (fieldNode) => {
              if (fieldNode.type !== 'field_declaration') return;
              const fieldType = receiverType(textOf(file.source, fieldNode.childForFieldName('type')));
              namedIdentifiers(fieldNode.childForFieldName('name')).forEach((fieldName) => {
                const fieldDefinition = recordDefinition(definitionFor({
                  source: file.source,
                  node: fieldNode,
                  nameNode: fieldName,
                  kind: 'field',
                  receiver: typeName,
                  packageName,
                  packagePath,
                  path: file.path,
                  ref,
                }), false);
                fields.set(textOf(file.source, fieldName), { type: fieldType, definition: fieldDefinition });
              });
            });
          }
          const kind = typeNode?.type === 'interface_type'
            ? 'interface'
            : typeNode?.type === 'struct_type' ? 'struct' : 'type';
          const definition = add(nameNode, kind);
          if (typeName) {
            entry.types.set(typeName, { fields });
            const record = {
              definition,
              file: fileEntry,
              name: typeName,
              identity: projectTypeIdentity(fileEntry, typeName),
              kind: kind === 'interface' ? 'interface' : 'type',
              methods: [],
              embedded: [],
              unsupported: '',
            };
            if (kind === 'interface') {
              for (const element of typeNode.namedChildren) {
                if (element.type === 'method_elem') record.methods.push(methodIdentity(fileEntry, element));
                if (element.type !== 'type_elem') continue;
                const elementSource = textOf(file.source, element);
                if (/[~|]/.test(elementSource) || element.namedChildren.length !== 1) {
                  record.unsupported = 'typeSetConstraint';
                  continue;
                }
                record.embedded.push(typeIdentity(fileEntry, element.namedChildren[0]));
              }
            }
            entry.typeRecords.push(record);
          }
        }
        if (node.type === 'method_elem') {
          let interfaceType = node.parent;
          while (interfaceType && interfaceType.type !== 'interface_type') interfaceType = interfaceType.parent;
          const typeSpec = interfaceType?.parent;
          add(node.childForFieldName('name'), 'interfaceMethod', textOf(file.source, typeSpec?.childForFieldName('name')), false);
        }
        if (node.type === 'const_spec') namedIdentifiers(node.childForFieldName('name') || node).forEach((name) => add(name, 'constant'));
        if (node.type === 'var_spec') {
          namedIdentifiers(node.childForFieldName('name') || node).forEach((name) => add(name, 'variable'));
          const assertion = assertionFor(fileEntry, node);
          if (assertion) entry.assertions.push(assertion);
        }
      });

      entry.files.set(file.path, fileEntry);
      this.files.set(fileKey(origin, project, ref, file.path), fileEntry);
    }
    this.packages.set(key, entry);
    return {
      status: 'indexed',
      packageName: entry.packageName,
      files: entry.files.size,
      definitions: entry.definitionsByLocation.size,
    };
  }

  indexProject({ origin = '', project, ref, modulePath = '', files }) {
    this.disposeProject({ origin, project, ref });
    const packages = new Map();
    for (const file of files) {
      const packagePath = dirname(file.path);
      const packageFiles = packages.get(packagePath) || [];
      packageFiles.push(file);
      packages.set(packagePath, packageFiles);
    }

    let definitions = 0;
    for (const [packagePath, packageFiles] of packages) {
      const result = this.indexPackage({ origin, project, ref, packagePath, modulePath, files: packageFiles });
      definitions += result.definitions;
    }
    this.projects.add(projectKey(origin, project, ref));
    return { status: 'projectIndexed', packages: packages.size, files: files.length, definitions };
  }

  packageRelations({ origin = '', project, ref, packagePath }) {
    const entry = this.packages.get(packageKey(origin, project, ref, packagePath));
    if (!entry) return { status: 'notFound', reason: 'packageNotIndexed' };
    const imports = new Set();
    const referenced = new Map();
    for (const file of entry.files.values()) {
      for (const importPath of file.importPaths) {
        const importedPackagePath = this.importToPackagePath(entry.modulePath, importPath);
        if (importedPackagePath !== null) imports.add(importedPackagePath);
      }
      walk(file.tree.rootNode, (node) => {
        let qualifierNode;
        let nameNode;
        if (node.type === 'selector_expression') {
          qualifierNode = node.childForFieldName('operand');
          nameNode = node.childForFieldName('field');
        } else if (node.type === 'qualified_type') {
          qualifierNode = node.childForFieldName('package');
          nameNode = node.childForFieldName('name');
        } else {
          return;
        }
        if (!qualifierNode || (qualifierNode.type !== 'identifier' && qualifierNode.type !== 'package_identifier')) return;
        const qualifier = textOf(file.source, qualifierNode);
        const importPath = file.imports.get(qualifier);
        const importedPackagePath = this.importToPackagePath(entry.modulePath, importPath);
        const name = textOf(file.source, nameNode);
        if (importedPackagePath === null || !name) return;
        const id = `${importedPackagePath}\u0000${name}`;
        referenced.set(id, { packagePath: importedPackagePath, importPath, name });
      });
    }
    const exportedDeclarations = [...entry.definitions.values()]
      .flat()
      .filter((definition) => /^\p{Lu}/u.test(definition.name))
      .map(({ name, kind, path, line }) => ({ name, kind, path, line }));
    const interfaces = entry.typeRecords
      .filter((record) => record.kind === 'interface' && record.definition)
      .map((record) => ({
        name: record.name,
        identity: record.identity,
        packagePath,
        methods: [...record.methods],
        methodNames: record.methods.map((method) => method.match(/^[^(]+/)?.[0] || '').filter(Boolean),
        embedded: [...record.embedded],
        definition: record.definition,
      }));
    return {
      status: 'relations',
      packagePath,
      imports: [...imports].sort(),
      referencedImports: [...referenced.values()].sort((left, right) => `${left.packagePath}.${left.name}`.localeCompare(`${right.packagePath}.${right.name}`)),
      exportedDeclarations,
      interfaces,
      assertions: entry.assertions.map((assertion) => ({ ...assertion })),
    };
  }

  findImplementations({ origin = '', project, ref, interfaceDefinition }) {
    const entries = [...this.packages.values()].filter((entry) => entry.origin === origin && entry.project === project && entry.ref === ref);
    const records = entries.flatMap((entry) => entry.typeRecords);
    const interfaceRecord = records.find((record) => record.kind === 'interface' && sameDefinition(record.definition, interfaceDefinition));
    if (!interfaceRecord) return { status: 'notFound', reason: 'interfaceNotIndexed' };

    const recordsByIdentity = new Map(records.map((record) => [record.identity, record]));
    const interfaces = new Map(records.filter((record) => record.kind === 'interface').map((record) => [record.identity, record]));
    const required = new Set();
    const visited = new Set();
    const collectMethods = (record) => {
      if (record.unsupported) return record.unsupported;
      if (visited.has(record.identity)) return '';
      visited.add(record.identity);
      record.methods.forEach((method) => required.add(method));
      for (const embeddedIdentity of record.embedded) {
        if (embeddedIdentity === 'builtin.any') continue;
        if (embeddedIdentity === 'builtin.comparable') return 'typeSetConstraint';
        const embedded = interfaces.get(embeddedIdentity);
        if (!embedded) return recordsByIdentity.has(embeddedIdentity) || embeddedIdentity.startsWith('builtin.')
          ? 'typeSetConstraint'
          : 'unresolvedEmbeddedInterface';
        const unsupported = collectMethods(embedded);
        if (unsupported) return unsupported;
      }
      return '';
    };
    const unsupported = collectMethods(interfaceRecord);
    if (unsupported) {
      return { status: 'unsupportedImplementations', reason: unsupported, interfaceDefinition };
    }

    const methods = entries.flatMap((entry) => entry.methods);
    const assertions = entries.flatMap((entry) => entry.assertions);
    const requiredMethods = [...required];
    const candidates = records
      .filter((record) => record.kind === 'type')
      .flatMap((record) => {
        const receiverMethods = methods.filter((method) => method.receiverIdentity === record.identity);
        const valueMethods = new Map(receiverMethods.filter((method) => !method.pointer).map((method) => [method.identity, method]));
        const pointerMethods = new Map(receiverMethods.map((method) => [method.identity, method]));
        const valueMatches = requiredMethods.every((method) => valueMethods.has(method));
        const pointerMatches = requiredMethods.every((method) => pointerMethods.has(method));
        if (!valueMatches && !pointerMatches) return [];
        const pointer = !valueMatches && pointerMatches;
        const matchedMethods = requiredMethods.map((method) => (pointer ? pointerMethods : valueMethods).get(method)).filter(Boolean);
        const asserted = assertions.some((assertion) => (
          assertion.interfaceIdentity === interfaceRecord.identity && assertion.typeIdentity === record.identity
        ));
        return [{
          ...record.definition,
          displayName: `${pointer ? '*' : ''}${record.file.packageName}.${record.name}`,
          pointer,
          matchedMethods: matchedMethods.length,
          methodCount: requiredMethods.length,
          confidence: asserted ? 'asserted' : 'structural',
          isTestDouble: testDoublePath(record.definition.path) || matchedMethods.some((method) => testDoublePath(method.definition.path)),
        }];
      })
      .sort((left, right) => {
        if (left.isTestDouble !== right.isTestDouble) return left.isTestDouble ? 1 : -1;
        if (left.confidence !== right.confidence) return left.confidence === 'asserted' ? -1 : 1;
        return `${left.packagePath}/${left.name}`.localeCompare(`${right.packagePath}/${right.name}`);
      });

    return {
      status: 'implementations',
      interfaceDefinition,
      methodCount: requiredMethods.length,
      candidates,
    };
  }

  resolve({ origin = '', project, ref, packagePath, path, line, character, identifier = '', occurrence = null }) {
    const entry = this.packages.get(packageKey(origin, project, ref, packagePath));
    const file = this.files.get(fileKey(origin, project, ref, path));
    if (!entry || !file) return { status: 'notFound', reason: 'packageNotIndexed' };

    const identifierNode = findIdentifierNode(file.tree.rootNode, file.source, line, character, identifier, occurrence, fileLines(file));
    if (!identifierNode) return { status: 'notFound', reason: 'identifierNotFound' };
    const symbol = textOf(file.source, identifierNode);
    const parent = identifierNode.parent;
    let candidates = [];
    let uncertain = false;
    const isSelectorField = parent?.type === 'selector_expression'
      && parent.childForFieldName('field')?.id === identifierNode.id;
    const isQualifiedTypeName = parent?.type === 'qualified_type'
      && parent.childForFieldName('name')?.id === identifierNode.id;
    const isQualifiedTypePackage = parent?.type === 'qualified_type'
      && parent.childForFieldName('package')?.id === identifierNode.id;
    const isSelectorOperand = parent?.type === 'selector_expression'
      && parent.childForFieldName('operand')?.id === identifierNode.id;
    const isImportAlias = parent?.type === 'import_spec'
      && parent.childForFieldName('name')?.id === identifierNode.id;
    const directDefinition = entry.definitionsByLocation.get(definitionLocationKey({
      path,
      line: identifierNode.startPosition.row + 1,
      column: identifierNode.startPosition.column + 1,
    }));

    if (directDefinition) {
      candidates = [directDefinition];
    } else if (isKeyedElementKey(identifierNode)) {
      const compositeType = compositeLiteralType(file, identifierNode);
      if (compositeType) {
        let memberEntry = entry;
        if (compositeType.qualifier) {
          const importPath = file.imports.get(compositeType.qualifier);
          const importedPackagePath = this.importToPackagePath(entry.modulePath, importPath);
          if (importedPackagePath === null) return { status: 'notFound', reason: 'memberSourceUnavailable', symbol };
          memberEntry = this.packages.get(packageKey(origin, project, ref, importedPackagePath));
          if (!memberEntry) return { status: 'needsPackage', packagePath: importedPackagePath, importPath, symbol };
        }
        candidates = memberDefinitions(memberEntry, symbol, compositeType.name, compositeType.qualifier ? memberEntry.packageName : file.packageName)
          .filter((definition) => definition.kind === 'field');
      }
    } else if (isSelectorField || isQualifiedTypeName) {
      const qualifierNode = isQualifiedTypeName
        ? parent.childForFieldName('package')
        : parent.childForFieldName('operand');
      const qualifier = textOf(file.source, qualifierNode);
      const importPath = file.imports.get(qualifier);
      if (importPath) {
        const importedPackagePath = this.importToPackagePath(entry.modulePath, importPath);
        if (importedPackagePath === null) {
          return externalImportResult(importPath, symbol);
        }
        const imported = this.packages.get(packageKey(origin, project, ref, importedPackagePath));
        if (!imported) return { status: 'needsPackage', packagePath: importedPackagePath, importPath, symbol };
        candidates = packageDefinitions(imported, symbol);
      } else if (isSelectorField) {
        const type = typeForExpression(entry, file, identifierNode, qualifierNode);
        candidates = memberDefinitions(entry, symbol, type, file.packageName);
        uncertain = !type;
      }
    } else if (isQualifiedTypePackage || isImportAlias) {
      const importPath = file.imports.get(symbol);
      if (importPath) {
        const importedPackagePath = this.importToPackagePath(entry.modulePath, importPath);
        if (importedPackagePath === null) return externalImportResult(importPath, symbol);
        return { status: 'projectPackage', importPath, packagePath: importedPackagePath, symbol, ref };
      }
    } else if (isSelectorOperand) {
      const localDefinition = localDefinitionFor(file, identifierNode, symbol);
      if (localDefinition) {
        candidates = [localDefinition];
      } else {
        const importPath = file.imports.get(symbol);
        if (importPath) {
          const importedPackagePath = this.importToPackagePath(entry.modulePath, importPath);
          if (importedPackagePath === null) return externalImportResult(importPath, symbol);
          return { status: 'projectPackage', importPath, packagePath: importedPackagePath, symbol, ref };
        }
        candidates = packageDefinitions(entry, symbol, file.packageName);
      }
    } else {
      const localDefinition = localDefinitionFor(file, identifierNode, symbol);
      candidates = localDefinition ? [localDefinition] : packageDefinitions(entry, symbol, file.packageName);
    }

    candidates = uniqueDefinitions(candidates);
    if (!candidates.length && PREDECLARED_FUNCTIONS.has(symbol) && !shadowsPredeclaredFunction(file, identifierNode, symbol)) return { status: 'builtin', symbol };
    if (!candidates.length) return { status: 'notFound', reason: 'definitionNotFound', symbol };
    if (uncertain || candidates.length > 1) return { status: 'ambiguous', symbol, definitions: candidates };
    const definition = candidates[0];
    return {
      status: 'resolved',
      symbol,
      definition,
      isDefinition: definition.path === path
        && definition.line === identifierNode.startPosition.row + 1
        && definition.column === identifierNode.startPosition.column + 1,
    };
  }

  findReferences({ origin = '', project, ref, packagePath, definition, limit = 5 }) {
    const sourceEntry = this.packages.get(packageKey(origin, project, ref, packagePath));
    if (!sourceEntry || !definition) return { status: 'notFound', reason: 'packageNotIndexed' };

    const locations = [];
    const entries = [...this.packages.values()].filter((entry) => entry.origin === origin && entry.project === project && entry.ref === ref);
    for (const entry of entries) {
      for (const file of entry.files.values()) {
        walk(file.tree.rootNode, (node) => {
          if (locations.length > limit || !IDENTIFIER_TYPES.has(node.type) || textOf(file.source, node) !== definition.name) return;
          const location = {
            path: file.path,
            ref: file.ref,
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
          };
          if (sameDefinition({ ...definition, ...location }, definition)) return;
          const result = this.resolve({
            origin,
            project,
            ref,
            packagePath: entry.packagePath,
            path: file.path,
            line: location.line,
            character: utf16Column(fileLines(file)[node.startPosition.row] || '', node.startPosition.column),
            identifier: definition.name,
          });
          if (result.status === 'resolved' && sameDefinition(result.definition, definition)) locations.push(location);
        });
        if (locations.length > limit) break;
      }
      if (locations.length > limit) break;
    }

    return {
      status: 'references',
      definition,
      locations: locations.slice(0, limit),
      hasMore: locations.length > limit,
    };
  }

  importToPackagePath(modulePath, importPath) {
    if (!importPath) return null;
    if (!modulePath || importPath === modulePath) return importPath === modulePath ? '' : null;
    if (!importPath.startsWith(`${modulePath}/`)) return null;
    return importPath.slice(modulePath.length + 1);
  }

  disposeProject({ origin = '', project, ref = '' }) {
    const prefix = `${origin}\u0000${project}\u0000${ref}`;
    for (const key of this.packages.keys()) if (key.startsWith(prefix)) this.packages.delete(key);
    for (const key of this.files.keys()) if (key.startsWith(prefix)) this.files.delete(key);
    for (const key of this.projects) if (key.startsWith(prefix)) this.projects.delete(key);
    return { status: 'disposed' };
  }
}
