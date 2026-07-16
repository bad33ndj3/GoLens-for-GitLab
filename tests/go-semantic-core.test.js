import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Language, Parser } from 'web-tree-sitter';
import { GoSemanticIndex } from '../go-semantic-core.js';

let index;

const searchSource = `package search

import "example.com/project/pkg/util"

// canonicalLocationToken builds the address token.
func canonicalLocationToken(postcode string, houseNumber int) string {
	return postcode
}

type Service struct{}

// Find returns a matching thing.
func (s *Service) Find(id string) string { return id }

const AddressNone = "none"
var DefaultService *Service

func run(service *Service) string {
	_ = canonicalLocationToken("1234AB", 5)
	_ = util.Helper("value")
	return service.Find(AddressNone)
}
`;

const utilSource = `package util

// Helper returns its input unchanged.
func Helper(value string) string { return value }
`;

function position(source, lineNumber, needle) {
  const line = source.split('\n')[lineNumber - 1];
  const character = line.indexOf(needle);
  assert.notEqual(character, -1, `expected ${needle} on line ${lineNumber}`);
  return { line: lineNumber, character, identifier: needle };
}

before(async () => {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(new URL('../vendor/tree-sitter-go.wasm', import.meta.url).pathname));
  index = new GoSemanticIndex(parser);
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/search',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/search/search.go', source: searchSource }],
  });
});

function resolve(sourcePosition) {
  return index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/search',
    path: 'pkg/search/search.go',
    ...sourcePosition,
  });
}

test('resolves a same-package function with signature and documentation', () => {
  const result = resolve(position(searchSource, 19, 'canonicalLocationToken'));
  assert.equal(result.status, 'resolved');
  assert.equal(result.definition.kind, 'function');
  assert.match(result.definition.signature, /^func canonicalLocationToken/);
  assert.equal(result.definition.documentation, 'canonicalLocationToken builds the address token.');
  assert.equal(result.definition.line, 6);
});

test('requests an imported project package lazily and resolves after indexing', () => {
  const target = position(searchSource, 20, 'Helper');
  const missing = resolve(target);
  assert.deepEqual(
    { status: missing.status, packagePath: missing.packagePath, symbol: missing.symbol },
    { status: 'needsPackage', packagePath: 'pkg/util', symbol: 'Helper' },
  );

  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/util',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/util/util.go', source: utilSource }],
  });
  const resolved = resolve(target);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.definition.path, 'pkg/util/util.go');
  assert.equal(resolved.definition.documentation, 'Helper returns its input unchanged.');
});

test('resolves project package qualifiers without indexing the imported package', () => {
  const target = position(searchSource, 20, 'util');
  assert.deepEqual(resolve(target), {
    status: 'projectPackage',
    importPath: 'example.com/project/pkg/util',
    packagePath: 'pkg/util',
    symbol: 'util',
    ref: 'abc123',
  });
});

test('resolves named project imports at their alias and qualified use', () => {
  const source = `package resolvers

import entityModel "example.com/project/svc/snapshot/internal/core/entity"

func labelsToProto(labels []*entityModel.Label) {}
`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'svc/snapshot/gql/resolvers',
    modulePath: 'example.com/project',
    files: [{ path: 'svc/snapshot/gql/resolvers/labels_alias.go', source }],
  });
  const base = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'svc/snapshot/gql/resolvers',
    path: 'svc/snapshot/gql/resolvers/labels_alias.go',
  };
  const expected = {
    status: 'projectPackage',
    importPath: 'example.com/project/svc/snapshot/internal/core/entity',
    packagePath: 'svc/snapshot/internal/core/entity',
    symbol: 'entityModel',
    ref: 'abc123',
  };
  assert.deepEqual(index.resolve({ ...base, ...position(source, 3, 'entityModel') }), expected);
  assert.deepEqual(index.resolve({ ...base, ...position(source, 5, 'entityModel') }), expected);
});

test('lazily resolves an imported qualified type in a composite literal', () => {
  const source = `package resolvers

import "example.com/project/svc/snapshot/gql/model"

func labelsToProto() {
	_ = &model.ContractLabel{}
}
`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'svc/snapshot/gql/resolvers',
    modulePath: 'example.com/project',
    files: [{ path: 'svc/snapshot/gql/resolvers/labels.go', source }],
  });
  const params = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'svc/snapshot/gql/resolvers',
    path: 'svc/snapshot/gql/resolvers/labels.go',
    ...position(source, 6, 'ContractLabel'),
  };
  assert.deepEqual(index.resolve({ ...params, ...position(source, 6, 'model') }), {
    status: 'projectPackage',
    importPath: 'example.com/project/svc/snapshot/gql/model',
    packagePath: 'svc/snapshot/gql/model',
    symbol: 'model',
    ref: 'abc123',
  });
  const missing = index.resolve(params);
  assert.deepEqual(
    { status: missing.status, packagePath: missing.packagePath, symbol: missing.symbol },
    { status: 'needsPackage', packagePath: 'svc/snapshot/gql/model', symbol: 'ContractLabel' },
  );

  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'svc/snapshot/gql/model',
    modulePath: 'example.com/project',
    files: [{ path: 'svc/snapshot/gql/model/models.go', source: 'package model\ntype ContractLabel struct{}\n' }],
  });
  const resolved = index.resolve(params);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.definition.kind, 'struct');
  assert.equal(resolved.definition.path, 'svc/snapshot/gql/model/models.go');
});

test('resolves function parameters and local variables without treating struct keys as usages', () => {
  const source = `package resolvers

func NewResolver(
	contractRepo ContractRepo,
) {
	res := &Resolver{
		contractRepo: contractRepo,
	}
	_ = res
}
`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'svc/snapshot/gql/resolvers',
    modulePath: 'example.com/project',
    files: [{ path: 'svc/snapshot/gql/resolvers/resolver.go', source }],
  });
  const base = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'svc/snapshot/gql/resolvers',
    path: 'svc/snapshot/gql/resolvers/resolver.go',
  };
  const parameter = index.resolve({ ...base, ...position(source, 4, 'contractRepo') });
  assert.equal(parameter.status, 'resolved');
  assert.equal(parameter.isDefinition, true);
  assert.equal(parameter.definition.kind, 'parameter');

  const usageLine = source.split('\n')[6];
  const parameterUsage = index.resolve({
    ...base,
    line: 7,
    character: usageLine.lastIndexOf('contractRepo'),
    identifier: 'contractRepo',
  });
  assert.equal(parameterUsage.status, 'resolved');
  assert.deepEqual(parameterUsage.definition, parameter.definition);

  const references = index.findReferences({
    project: base.project,
    ref: base.ref,
    packagePath: base.packagePath,
    definition: parameter.definition,
  });
  assert.deepEqual(references.locations.map(({ line, column }) => ({ line, column })), [{ line: 7, column: 17 }]);

  const localUsage = index.resolve({ ...base, ...position(source, 9, 'res') });
  assert.equal(localUsage.status, 'resolved');
  assert.equal(localUsage.definition.kind, 'variable');
  assert.equal(localUsage.definition.line, 6);
});

test('resolves a method using an explicit parameter receiver type', () => {
  const result = resolve(position(searchSource, 21, 'Find'));
  assert.equal(result.status, 'resolved');
  assert.equal(result.definition.kind, 'method');
  assert.equal(result.definition.receiver, 'Service');
  assert.equal(result.definition.line, 13);
});

test('resolves a method call through a receiver field to its interface declaration', () => {
  const source = `package repository

type UserRepo interface {
	// List returns all users.
	List() error
}

type Resolver struct { repo UserRepo }

func (r *Resolver) Load() error {
	return r.repo.List()
}

type postgresRepo struct{}
func (postgresRepo) List() error { return nil }
`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/repository',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/repository/repository.go', source }],
  });
  const result = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/repository',
    path: 'pkg/repository/repository.go',
    ...position(source, 11, 'List'),
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.definition.kind, 'interfaceMethod');
  assert.equal(result.definition.receiver, 'UserRepo');
  assert.equal(result.definition.documentation, 'List returns all users.');
  assert.equal(result.definition.line, 5);
});

test('keeps package functions, methods, and fields in their Go namespaces', () => {
  const source = `package collisions

func Foo() string { return "function" }

type WithField struct {
	Foo string
}

type WithMethod struct{}
func (WithMethod) Foo() string { return "method" }

func Use(field WithField, method WithMethod) {
	_ = Foo()
	_ = field.Foo
	_ = method.Foo()
	_ = WithField{Foo: "field"}
}
`;
  const base = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/collisions',
    path: 'pkg/collisions/collisions.go',
  };
  index.indexPackage({ ...base, modulePath: 'example.com/project', files: [{ path: base.path, source }] });

  const packageFunction = index.resolve({ ...base, ...position(source, 13, 'Foo') });
  assert.equal(packageFunction.status, 'resolved');
  assert.equal(packageFunction.definition.kind, 'function');
  assert.equal(packageFunction.definition.line, 3);

  const field = index.resolve({ ...base, ...position(source, 14, 'Foo') });
  assert.equal(field.status, 'resolved');
  assert.equal(field.definition.kind, 'field');
  assert.equal(field.definition.receiver, 'WithField');
  assert.equal(field.definition.line, 6);

  const method = index.resolve({ ...base, ...position(source, 15, 'Foo') });
  assert.equal(method.status, 'resolved');
  assert.equal(method.definition.kind, 'method');
  assert.equal(method.definition.receiver, 'WithMethod');

  const keyedField = index.resolve({ ...base, ...position(source, 16, 'Foo') });
  assert.equal(keyedField.status, 'resolved');
  assert.deepEqual(keyedField.definition, field.definition);

  const fieldDeclaration = index.resolve({ ...base, ...position(source, 6, 'Foo') });
  assert.equal(fieldDeclaration.isDefinition, true);
  assert.deepEqual(fieldDeclaration.definition, field.definition);
});

test('returns typed member choices instead of guessing when a selector receiver is unknown', () => {
  const source = `package choices

type FieldOwner struct { Foo string }
type MethodOwner struct{}
func (MethodOwner) Foo() {}
func Build() any { return nil }
func Use() { _ = Build().Foo }
`;
  const base = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/choices',
    path: 'pkg/choices/choices.go',
  };
  index.indexPackage({ ...base, modulePath: 'example.com/project', files: [{ path: base.path, source }] });
  const result = index.resolve({ ...base, ...position(source, 7, 'Foo') });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(
    result.definitions.map(({ kind, receiver }) => ({ kind, receiver })),
    [{ kind: 'field', receiver: 'FieldOwner' }, { kind: 'method', receiver: 'MethodOwner' }],
  );
});

test('uses rendered occurrence order when repeated names have different symbol roles', () => {
  const source = `package occurrences
func Foo() {}
type Holder struct { Foo string }
func Use(value Holder) { _ = value.Foo; Foo() }
`;
  const base = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/occurrences',
    path: 'pkg/occurrences/occurrences.go',
    line: 4,
    character: 0,
    identifier: 'Foo',
  };
  index.indexPackage({ ...base, modulePath: 'example.com/project', files: [{ path: base.path, source }] });
  const field = index.resolve({ ...base, occurrence: 0 });
  const fn = index.resolve({ ...base, occurrence: 1 });
  assert.equal(field.status, 'resolved');
  assert.equal(field.definition.kind, 'field');
  assert.equal(fn.status, 'resolved');
  assert.equal(fn.definition.kind, 'function');
});

test('does not expose a new local binding inside its own initializer', () => {
  const source = `package scope
func Foo() {}
func Use() { Foo := Foo; _ = Foo }
`;
  const base = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/scope',
    path: 'pkg/scope/scope.go',
  };
  index.indexPackage({ ...base, modulePath: 'example.com/project', files: [{ path: base.path, source }] });
  const line = source.split('\n')[2];
  const occurrences = [...line.matchAll(/Foo/g)].map((match) => match.index);
  const resolveFoo = (character) => index.resolve({ ...base, line: 3, character, identifier: 'Foo' });
  const declaration = resolveFoo(occurrences[0]);
  const initializer = resolveFoo(occurrences[1]);
  const laterUsage = resolveFoo(occurrences[2]);
  assert.equal(declaration.definition.kind, 'variable');
  assert.equal(initializer.definition.kind, 'function');
  assert.equal(laterUsage.definition.kind, 'variable');
  assert.deepEqual(laterUsage.definition, declaration.definition);
});

test('coalesces long callable signatures at complete parameter boundaries', () => {
  const source = `package signatures
func NewContractService(db *gorm.DB, invoiceCreditor InvoiceCreditor, emailClient EmailClient, metrics ContractMetrics, legacyContractRepository LegacyContractRepository, contractRepository ContractRepository, publisher ContractPublisher, contractLabelRepository ContractLabelRepository, productGroupRepository ProductGroupRepository, contractStorageClient ContractStorageClient, locationService LocationService, depositCalculationService DepositCalculationService, collectiveRepository CollectiveRepository, vendorRepository VendorRepository, userRepository UserRepository) *ContractService { return nil }
`;
  const base = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/signatures',
    path: 'pkg/signatures/signatures.go',
  };
  index.indexPackage({ ...base, modulePath: 'example.com/project', files: [{ path: base.path, source }] });
  const result = index.resolve({ ...base, ...position(source, 2, 'NewContractService') });
  assert.equal(result.status, 'resolved');
  assert.ok(result.definition.signature.length > 160);
  assert.ok(result.definition.compactSignature.length <= 160);
  assert.match(result.definition.compactSignature, /^func NewContractService\(/);
  assert.match(result.definition.compactSignature, /… \+\d+ parameters\) \*ContractService$/);
  assert.match(result.definition.signature, /userRepository UserRepository/);
  assert.doesNotMatch(result.definition.compactSignature, /userRepository UserRepository/);
});

test('uses the rendered identifier when a diff marker offsets the visual column', () => {
  const result = resolve({ line: 19, character: 0, identifier: 'canonicalLocationToken' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.definition.kind, 'function');
});

test('indexes package structs, constants, and variables', () => {
  const constant = resolve(position(searchSource, 21, 'AddressNone'));
  assert.equal(constant.status, 'resolved');
  assert.equal(constant.definition.kind, 'constant');

  const type = resolve(position(searchSource, 18, 'Service'));
  assert.equal(type.status, 'resolved');
  assert.equal(type.definition.kind, 'struct');
});

test('keeps non-struct named declarations as types', () => {
  const source = 'package identifiers\ntype Identifier string\n';
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/identifiers',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/identifiers/identifier.go', source }],
  });
  const result = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/identifiers',
    path: 'pkg/identifiers/identifier.go',
    ...position(source, 2, 'Identifier'),
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.definition.kind, 'type');
});

test('extracts immediately preceding documentation for Go declaration forms', () => {
  const source = `package documented

// Widget is a documented interface.
type Widget interface { Run() }

// Run implements Widget.
func (widget service) Run() {}

const (
	// DefaultLimit controls batch size.
	DefaultLimit = 20
)

// DefaultWidget is used when none is provided.
var DefaultWidget Widget
`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/documented',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/documented/documented.go', source }],
  });
  const base = {
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/documented',
    path: 'pkg/documented/documented.go',
  };
  for (const [line, name, documentation, documentationLine] of [
    [4, 'Widget', 'Widget is a documented interface.', 3],
    [7, 'Run', 'Run implements Widget.', 6],
    [11, 'DefaultLimit', 'DefaultLimit controls batch size.', 10],
    [15, 'DefaultWidget', 'DefaultWidget is used when none is provided.', 14],
  ]) {
    const result = index.resolve({ ...base, ...position(source, line, name) });
    assert.equal(result.status, 'resolved');
    assert.equal(result.definition.documentation, documentation);
    assert.equal(result.definition.documentationLine, documentationLine);
  }
});

test('returns standard-library documentation targets for standard imports', () => {
  const source = `package sample\nimport "fmt"\nfunc Run() { fmt.Println("ok") }\n`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/sample',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/sample/sample.go', source }],
  });
  const result = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/sample',
    path: 'pkg/sample/sample.go',
    ...position(source, 3, 'Println'),
  });
  assert.deepEqual(result, { status: 'standardLibrary', importPath: 'fmt', symbol: 'Println' });

  const packageResult = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/sample',
    path: 'pkg/sample/sample.go',
    ...position(source, 3, 'fmt'),
  });
  assert.deepEqual(packageResult, { status: 'standardLibrary', importPath: 'fmt', symbol: 'fmt' });
});

test('returns package documentation targets for third-party imports', () => {
  const source = `package external\nimport "github.com/acme/tool"\nfunc Run() { tool.Use() }\n`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/external',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/external/external.go', source }],
  });
  const result = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/external',
    path: 'pkg/external/external.go',
    ...position(source, 3, 'Use'),
  });
  assert.deepEqual(result, { status: 'packageDocumentation', importPath: 'github.com/acme/tool', symbol: 'Use' });
});

test('returns documentation targets for predeclared Go functions', () => {
  const source = 'package builtin\nfunc Use(values []string) int { return len(values) }\n';
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/builtin',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/builtin/builtin.go', source }],
  });
  const result = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/builtin',
    path: 'pkg/builtin/builtin.go',
    ...position(source, 2, 'len'),
  });
  assert.deepEqual(result, { status: 'builtin', symbol: 'len' });
});

test('resolves a locally shadowed predeclared function to the local variable', () => {
  const source = 'package builtin\nfunc Use(values []string) int { len := func([]string) int { return 0 }; return len(values) }\n';
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/shadowed-builtin',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/shadowed-builtin/builtin.go', source }],
  });
  const result = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/shadowed-builtin',
    path: 'pkg/shadowed-builtin/builtin.go',
    line: 2,
    character: source.split('\n')[1].lastIndexOf('len'),
    identifier: 'len',
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.definition.kind, 'variable');
  assert.equal(result.definition.name, 'len');
});

test('returns ambiguous rather than guessing between duplicate declarations', () => {
  const source = `package duplicate\nfunc Use() { Shared() }\n`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/duplicate',
    modulePath: 'example.com/project',
    files: [
      { path: 'pkg/duplicate/use.go', source },
      { path: 'pkg/duplicate/a.go', source: 'package duplicate\nfunc Shared() {}\n' },
      { path: 'pkg/duplicate/b.go', source: 'package duplicate\nfunc Shared() {}\n' },
    ],
  });
  const result = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/duplicate',
    path: 'pkg/duplicate/use.go',
    ...position(source, 2, 'Shared'),
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.definitions.length, 2);
});

test('finds at most five usages after clicking a definition', () => {
  const source = `package usages

func Target() {}

func Use() {
	Target()
	Target()
	Target()
	Target()
	Target()
	Target()
}
`;
  index.indexPackage({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/usages',
    modulePath: 'example.com/project',
    files: [{ path: 'pkg/usages/usages.go', source }],
  });
  const definitionResult = index.resolve({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/usages',
    path: 'pkg/usages/usages.go',
    ...position(source, 3, 'Target'),
  });
  assert.equal(definitionResult.status, 'resolved');
  assert.equal(definitionResult.isDefinition, true);

  const references = index.findReferences({
    project: 'group/project',
    ref: 'abc123',
    packagePath: 'pkg/usages',
    definition: definitionResult.definition,
  });
  assert.equal(references.status, 'references');
  assert.deepEqual(references.locations.map((location) => location.line), [6, 7, 8, 9, 10]);
  assert.equal(references.hasMore, true);
});

test('finds project-wide interface implementations with context and confidence', () => {
  const implementationIndex = new GoSemanticIndex(index.parser);
  const contracts = `package contracts

type Reader interface {
	Read(buffer []byte) (count int, err error)
}

type Closer interface { Close() error }
type ReadCloser interface { Reader; Closer }
`;
  const storage = `package storage

import "example.com/project/contracts"

// File reads production data.
type File struct{}
func (*File) Read(p []byte) (int, error) { return 0, nil }
func (*File) Close() error { return nil }
var _ contracts.ReadCloser = &File{}

type ValueFile struct{}
func (ValueFile) Read(p []byte) (int, error) { return 0, nil }
func (ValueFile) Close() error { return nil }

type WrongFile struct{}
func (*WrongFile) Read(value string) (int, error) { return 0, nil }
func (*WrongFile) Close() error { return nil }
`;
  const mocks = `package mocks

type FakeFile struct{}
func (*FakeFile) Read(p []byte) (int, error) { return 0, nil }
func (*FakeFile) Close() error { return nil }
`;
  const indexed = implementationIndex.indexProject({
    project: 'group/project',
    ref: 'feed123',
    modulePath: 'example.com/project',
    files: [
      { path: 'contracts/contracts.go', source: contracts },
      { path: 'storage/file.go', source: storage },
      { path: 'internal/mocks/file.go', source: mocks },
    ],
  });
  assert.deepEqual(
    { status: indexed.status, packages: indexed.packages, files: indexed.files },
    { status: 'projectIndexed', packages: 3, files: 3 },
  );

  const resolved = implementationIndex.resolve({
    project: 'group/project',
    ref: 'feed123',
    packagePath: 'contracts',
    path: 'contracts/contracts.go',
    ...position(contracts, 8, 'ReadCloser'),
  });
  assert.equal(resolved.definition.kind, 'interface');
  const result = implementationIndex.findImplementations({
    project: 'group/project',
    ref: 'feed123',
    interfaceDefinition: resolved.definition,
  });
  assert.equal(result.status, 'implementations');
  assert.equal(result.methodCount, 2);
  assert.deepEqual(
    result.candidates.map(({ displayName, confidence, isTestDouble, pointer, matchedMethods }) => ({ displayName, confidence, isTestDouble, pointer, matchedMethods })),
    [
      { displayName: '*storage.File', confidence: 'asserted', isTestDouble: false, pointer: true, matchedMethods: 2 },
      { displayName: 'storage.ValueFile', confidence: 'structural', isTestDouble: false, pointer: false, matchedMethods: 2 },
      { displayName: '*mocks.FakeFile', confidence: 'structural', isTestDouble: true, pointer: true, matchedMethods: 2 },
    ],
  );
  assert.equal(result.candidates[0].documentation, 'File reads production data.');
});

test('does not guess implementations for unresolved embeddings or type-set constraints', () => {
  const implementationIndex = new GoSemanticIndex(index.parser);
  const source = `package contracts

import "io"

type ExternalReader interface { io.Reader }
type Number interface { ~int | ~int64 }
`;
  implementationIndex.indexProject({
    project: 'group/project',
    ref: 'unsupported123',
    modulePath: 'example.com/project',
    files: [{ path: 'contracts/contracts.go', source }],
  });
  for (const [line, name, reason] of [
    [5, 'ExternalReader', 'unresolvedEmbeddedInterface'],
    [6, 'Number', 'typeSetConstraint'],
  ]) {
    const resolved = implementationIndex.resolve({
      project: 'group/project',
      ref: 'unsupported123',
      packagePath: 'contracts',
      path: 'contracts/contracts.go',
      ...position(source, line, name),
    });
    const result = implementationIndex.findImplementations({
      project: 'group/project',
      ref: 'unsupported123',
      interfaceDefinition: resolved.definition,
    });
    assert.equal(result.status, 'unsupportedImplementations');
    assert.equal(result.reason, reason);
  }
});

test('resolves version-suffixed imports to their declared package convention', () => {
  const localIndex = new GoSemanticIndex(index.parser);
  const source = `package versioned

import "math/rand/v2"

func use() { _ = rand.Int() }
`;
  localIndex.indexPackage({
    project: 'group/versioned', ref: 'versioned', packagePath: '', modulePath: 'example.com/versioned',
    files: [{ path: 'main.go', source }],
  });
  const result = localIndex.resolve({
    project: 'group/versioned', ref: 'versioned', packagePath: '', path: 'main.go',
    ...position(source, 5, 'Int'),
  });
  assert.deepEqual(result, { status: 'standardLibrary', importPath: 'math/rand/v2', symbol: 'Int' });
});

test('resolves methods on instantiated generic receiver types', () => {
  const localIndex = new GoSemanticIndex(index.parser);
  const source = `package generic

type Box[T any] struct{}
func (b Box[T]) Get() T { var zero T; return zero }
func use(box Box[int]) { _ = box.Get() }
`;
  localIndex.indexPackage({
    project: 'group/generic', ref: 'generic', packagePath: 'generic', modulePath: 'example.com/generic',
    files: [{ path: 'generic/box.go', source }],
  });
  const result = localIndex.resolve({
    project: 'group/generic', ref: 'generic', packagePath: 'generic', path: 'generic/box.go',
    ...position(source, 5, 'Get'),
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.definition.kind, 'method');
  assert.equal(result.definition.receiver, 'Box');
});

test('keeps external test packages out of the production package namespace', () => {
  const localIndex = new GoSemanticIndex(index.parser);
  const production = 'package service\n\nfunc Helper() {}\nfunc use() { Helper() }\n';
  const externalTest = 'package service_test\n\nfunc Helper() {}\n';
  localIndex.indexPackage({
    project: 'group/package-variant', ref: 'variant', packagePath: 'service', modulePath: 'example.com/variant',
    files: [
      { path: 'service/a_test.go', source: externalTest },
      { path: 'service/service.go', source: production },
    ],
  });
  const result = localIndex.resolve({
    project: 'group/package-variant', ref: 'variant', packagePath: 'service', path: 'service/service.go',
    ...position(production, 4, 'Helper'),
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.definition.path, 'service/service.go');
});

test('uses UTF-16 browser columns and UTF-8 parser columns without losing references', () => {
  const localIndex = new GoSemanticIndex(index.parser);
  const source = `package unicode

func Target() {}
func use() { π := "é"; _ = π; Target() }
`;
  localIndex.indexPackage({
    project: 'group/unicode', ref: 'unicode', packagePath: 'unicode', modulePath: 'example.com/unicode',
    files: [{ path: 'unicode/main.go', source }],
  });
  const definition = localIndex.resolve({
    project: 'group/unicode', ref: 'unicode', packagePath: 'unicode', path: 'unicode/main.go',
    ...position(source, 3, 'Target'),
  }).definition;
  const references = localIndex.findReferences({
    project: 'group/unicode', ref: 'unicode', packagePath: 'unicode', definition,
  });
  assert.equal(references.status, 'references');
  assert.equal(references.locations.length, 1);
  assert.equal(references.locations[0].line, 4);
});

test('keeps short-declaration redeclarations and range assignments bound to their original local', () => {
  const localIndex = new GoSemanticIndex(index.parser);
  const source = `package locals

func use(x int, items []int) {
	x, y := x, 1
	_ = x
	_ = y
	var item int
	for _, item = range items { _ = item }
}
`;
  localIndex.indexPackage({
    project: 'group/locals', ref: 'locals', packagePath: 'locals', modulePath: 'example.com/locals',
    files: [{ path: 'locals/main.go', source }],
  });
  const x = localIndex.resolve({
    project: 'group/locals', ref: 'locals', packagePath: 'locals', path: 'locals/main.go',
    ...position(source, 5, 'x'),
  });
  const item = localIndex.resolve({
    project: 'group/locals', ref: 'locals', packagePath: 'locals', path: 'locals/main.go',
    ...position(source, 8, 'item'), occurrence: 1,
  });
  assert.equal(x.definition.kind, 'parameter');
  assert.equal(x.definition.line, 3);
  assert.equal(item.definition.kind, 'variable');
  assert.equal(item.definition.line, 7);
});

test('drops stale file entries when a mutable package is reindexed', () => {
  const localIndex = new GoSemanticIndex(index.parser);
  const scope = { project: 'group/mutable', ref: 'main', packagePath: 'mutable', modulePath: 'example.com/mutable' };
  localIndex.indexPackage({ ...scope, files: [{ path: 'mutable/old.go', source: 'package mutable\nfunc Gone() {}\n' }] });
  localIndex.indexPackage({ ...scope, files: [{ path: 'mutable/new.go', source: 'package mutable\nfunc Current() {}\n' }] });
  assert.deepEqual(localIndex.resolve({
    project: scope.project, ref: scope.ref, packagePath: scope.packagePath, path: 'mutable/old.go',
    line: 2, character: 5, identifier: 'Gone',
  }), { status: 'notFound', reason: 'packageNotIndexed' });
});

test('disposeProject removes indexed state', () => {
  index.disposeProject({ project: 'group/project', ref: 'abc123' });
  const result = resolve(position(searchSource, 19, 'canonicalLocationToken'));
  assert.equal(result.status, 'notFound');
  assert.equal(result.reason, 'packageNotIndexed');
});

test('keeps in-memory semantic state isolated by GitLab origin', () => {
  const localIndex = new GoSemanticIndex(index.parser);
  const firstSource = 'package sample\n// Target comes from the first origin.\nfunc Target() {}\n';
  const secondSource = 'package sample\n// Target comes from the second origin.\nfunc Target() {}\n';
  const scope = { project: 'group/project', ref: 'same-ref', packagePath: 'sample' };
  localIndex.indexPackage({ origin: 'https://one.example', ...scope, files: [{ path: 'sample/sample.go', source: firstSource }] });
  localIndex.indexPackage({ origin: 'https://two.example', ...scope, files: [{ path: 'sample/sample.go', source: secondSource }] });

  const resolveOrigin = (origin) => localIndex.resolve({
    origin,
    ...scope,
    path: 'sample/sample.go',
    line: 3,
    character: 5,
    identifier: 'Target',
  });
  assert.equal(resolveOrigin('https://one.example').definition.documentation, 'Target comes from the first origin.');
  assert.equal(resolveOrigin('https://two.example').definition.documentation, 'Target comes from the second origin.');

  localIndex.disposeProject({ origin: 'https://one.example', project: scope.project, ref: scope.ref });
  assert.equal(resolveOrigin('https://one.example').status, 'notFound');
  assert.equal(resolveOrigin('https://two.example').status, 'resolved');
});

test('tracks when a complete project index is available', () => {
  const source = 'package sample\nfunc Target() {}\n';
  index.indexProject({
    project: 'group/project',
    ref: 'complete-project',
    files: [{ path: 'sample/sample.go', source }],
  });
  assert.equal(index.hasProject({ project: 'group/project', ref: 'complete-project' }), true);
  index.disposeProject({ project: 'group/project', ref: 'complete-project' });
  assert.equal(index.hasProject({ project: 'group/project', ref: 'complete-project' }), false);
});

test('reports package relationships and finds references in indexed reverse dependencies', () => {
  const relationIndex = new GoSemanticIndex(index.parser);
  const contracts = `package contracts

type Runner interface { Run() error }
`;
  const service = `package service

import "example.com/project/contracts"

func Start(value contracts.Runner) error { return value.Run() }
`;
  relationIndex.indexPackage({
    project: 'group/project', ref: 'related-ref', packagePath: 'contracts', modulePath: 'example.com/project',
    files: [{ path: 'contracts/runner.go', source: contracts }],
  });
  relationIndex.indexPackage({
    project: 'group/project', ref: 'related-ref', packagePath: 'service', modulePath: 'example.com/project',
    files: [{ path: 'service/start.go', source: service }],
  });

  const relations = relationIndex.packageRelations({ project: 'group/project', ref: 'related-ref', packagePath: 'service' });
  assert.deepEqual(relations.imports, ['contracts']);
  assert.deepEqual(relations.referencedImports, [{
    packagePath: 'contracts', importPath: 'example.com/project/contracts', name: 'Runner',
  }]);
  assert.deepEqual(relationIndex.packageRelations({ project: 'group/project', ref: 'related-ref', packagePath: 'contracts' }).interfaces[0].methodNames, ['Run']);

  const resolved = relationIndex.resolve({
    project: 'group/project', ref: 'related-ref', packagePath: 'contracts', path: 'contracts/runner.go',
    ...position(contracts, 3, 'Runner'),
  });
  const references = relationIndex.findReferences({
    project: 'group/project', ref: 'related-ref', packagePath: 'contracts', definition: resolved.definition,
  });
  assert.deepEqual(references.locations.map(({ path, line }) => ({ path, line })), [{ path: 'service/start.go', line: 5 }]);
});
