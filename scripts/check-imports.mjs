import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(process.argv[2] || new URL('../src', import.meta.url).pathname);
const entryRoots = new Set(['content.ts', 'worker.ts', 'popup.ts', 'settings.ts']);
const directModules = new Set(['domain.ts', 'feature-catalog.ts', 'shortcuts.ts', 'user-storage.ts']);
const packages = new Set(['review-session', 'gitlab-host', 'go-intelligence']);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const lockedPackages = new Set([...Object.keys(packageJson.dependencies || {}), ...Object.keys(packageJson.devDependencies || {})]);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : extname(path) === '.ts' ? [path] : [];
  }));
  return files.flat();
}

function imports(source) {
  const runtimeSource = source.replace(/(?:import|export)\s+type\b[^;]*;?/g, '');
  const matches = runtimeSource.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g);
  return [...matches].map((match) => match[1] || match[2]);
}

function resolveImport(from, specifier, known) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, join(base, 'index.ts')].find((candidate) => known.has(candidate));
}

function owner(path) {
  const [first] = relative(sourceRoot, path).split(sep);
  return packages.has(first) ? first : undefined;
}

function validateEdge(from, to) {
  const fromRelative = relative(sourceRoot, from);
  const toRelative = relative(sourceRoot, to);
  const fromOwner = owner(from);
  const toOwner = owner(to);

  if (fromOwner && entryRoots.has(toRelative)) throw new Error(`${fromRelative} imports composition root ${toRelative}`);
  if (fromOwner && directModules.has(toRelative) && toRelative !== 'domain.ts') throw new Error(`${fromRelative} imports ${toRelative}`);
  if (fromOwner && !toOwner && toRelative !== 'domain.ts') throw new Error(`${fromRelative} imports root module ${toRelative}`);
  if (fromOwner !== toOwner && toOwner) {
    if (toRelative !== join(toOwner, 'index.ts')) throw new Error(`${fromRelative} imports private ${toRelative}`);
    const allowed = entryRoots.has(fromRelative) || (fromOwner === 'review-session' && toOwner !== 'review-session');
    if (!allowed) throw new Error(`${fromRelative} cannot import ${toOwner}`);
  }
  if (!fromOwner && directModules.has(fromRelative) && toRelative !== 'domain.ts') {
    throw new Error(`${fromRelative} imports ${toRelative}`);
  }
}

function rejectCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  function visit(file) {
    if (visiting.has(file)) throw new Error(`runtime import cycle at ${relative(sourceRoot, file)}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
}

const files = await sourceFiles(sourceRoot);
const known = new Set(files);
const graph = new Map();
for (const file of files) {
  const specifiers = imports(await readFile(file, 'utf8'));
  for (const specifier of specifiers.filter((value) => !value.startsWith('.'))) {
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (!lockedPackages.has(name)) throw new Error(`${relative(sourceRoot, file)} imports unlocked package ${name}`);
  }
  const dependencies = specifiers
    .map((specifier) => resolveImport(file, specifier, known))
    .filter(Boolean);
  for (const dependency of dependencies) validateEdge(file, dependency);
  graph.set(file, dependencies);
}
rejectCycles(graph);
console.log(`Import rules passed (${files.length} files).`);
