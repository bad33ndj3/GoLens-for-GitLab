// Synthetic Go project generator for benchmarking `go-semantic-core.js`.
//
// Deterministic: no randomness, no clock reads. Every call with the same
// parameters produces byte-identical output, so benchmark timings are
// comparable across runs.
//
// Shape, per package `pkgNNN` (zero-padded):
//   - file 0 ("primary"): a `ClientNNN` struct with `New`/`Err`/`Client`
//     methods, plus an interface. Package 0's primary file additionally
//     defines the `Doer` interface used by the `findImplementations`
//     benchmark.
//   - files 1..filesPerPackage-1 ("secondary"): a `HelperNNN_J` struct that
//     also carries `Err`/`Client`-named methods, references the package's
//     own `New()`, and imports the previous package to exercise
//     cross-package resolution.
//   - A subset of packages additionally define an `ImplNNN` struct with a
//     `Do() error` method, giving `Doer` several structural implementors.

const MODULE_PATH = 'example.com/bench';

function pad(value) {
  return String(value).padStart(3, '0');
}

function packagePath(index) {
  return `pkg${pad(index)}`;
}

function primaryFile(index, { withDoerInterface, implementsDoer }) {
  const path = `${packagePath(index)}/file000.go`;
  const previous = index > 0 ? packagePath(index - 1) : '';
  const importBlock = previous
    ? `\nimport "${MODULE_PATH}/${previous}"\n`
    : '\n';
  const doerInterface = withDoerInterface
    ? `\n// Doer is implemented by every ImplNNN type across the project.\ntype Doer interface {\n\tDo() error\n}\n`
    : '';
  const implType = implementsDoer
    ? `\n// Impl${pad(index)} structurally implements Doer.\ntype Impl${pad(index)} struct{}\n\n// Do satisfies Doer.\nfunc (i *Impl${pad(index)}) Do() error { return nil }\n`
    : '';
  const previousUse = previous
    ? `\n// UsePrevious references the previous package's constructor to create a\n// cross-package reference edge for the synthetic project.\nfunc UsePrevious() *${previous}.Client${pad(index - 1)} {\n\treturn ${previous}.New()\n}\n`
    : '';
  return {
    path,
    source: `package pkg${pad(index)}
${importBlock}
// Client${pad(index)} is the package's primary exported type.
type Client${pad(index)} struct {
	Err  error
	Next *Client${pad(index)}
}

// Service${pad(index)} groups this package's primary behaviour.
type Service${pad(index)} interface {
	Client() *Client${pad(index)}
}

// New constructs a Client${pad(index)}.
func New() *Client${pad(index)} {
	return &Client${pad(index)}{}
}

// Err returns the client's stored error.
func (c *Client${pad(index)}) Err() error {
	return c.Err
}

// Client returns itself, satisfying Service${pad(index)}.
func (c *Client${pad(index)}) Client() *Client${pad(index)} {
	return c
}
${doerInterface}${implType}${previousUse}`,
  };
}

function secondaryFile(index, fileIndex) {
  const path = `${packagePath(index)}/file${pad(fileIndex)}.go`;
  const name = `Helper${pad(index)}_${pad(fileIndex)}`;
  return {
    path,
    source: `package pkg${pad(index)}

// ${name} is a secondary type used to widen the identifier index.
type ${name} struct {
	Err   error
	Value int
}

// New${name} constructs a ${name} and calls the package constructor to
// create an intra-package reference to the widely used New identifier.
func New${name}() *${name} {
	_ = New()
	return &${name}{}
}

// Err returns the helper's stored error, reusing the widely used Err name.
func (h *${name}) Err() error {
	return h.Err
}

// Client returns the package's primary client, reusing the widely used
// Client name.
func (h *${name}) Client() *Client${pad(index)} {
	return New()
}
`,
  };
}

/**
 * @param {{ packageCount?: number, filesPerPackage?: number }} [options]
 * @returns {{ modulePath: string, files: { path: string, source: string }[] }}
 */
export function buildSyntheticProject({ packageCount = 40, filesPerPackage = 8 } = {}) {
  const files = [];
  for (let index = 0; index < packageCount; index++) {
    // Every third package (skipping 0, which only hosts the interface)
    // implements Doer, giving findImplementations several real candidates.
    const implementsDoer = index > 0 && index % 3 === 0;
    files.push(primaryFile(index, { withDoerInterface: index === 0, implementsDoer }));
    for (let fileIndex = 1; fileIndex < filesPerPackage; fileIndex++) {
      files.push(secondaryFile(index, fileIndex));
    }
  }
  return { modulePath: MODULE_PATH, files };
}

export const SYNTHETIC_MODULE_PATH = MODULE_PATH;

export function syntheticPackagePath(index) {
  return packagePath(index);
}
