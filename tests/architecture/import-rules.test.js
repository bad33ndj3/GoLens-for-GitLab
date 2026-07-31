import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = join(root, 'scripts', 'check-imports.mjs');

function check(sourceRoot) {
  return execFileSync(process.execPath, [checker, sourceRoot], { encoding: 'utf8' });
}

test('accepted source dependency graph passes', () => {
  assert.match(check(join(root, 'src')), /Import rules passed/);
});

test('import rules reject private cross-package imports', async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), 'golens-import-rules-'));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'review-session'));
  await mkdir(join(fixture, 'gitlab-host'));
  await writeFile(join(fixture, 'review-session', 'index.ts'), "import '../gitlab-host/dom.ts';\n");
  await writeFile(join(fixture, 'gitlab-host', 'dom.ts'), "import '../review-session/index.ts';\n");

  assert.throws(() => check(fixture), /Command failed/);
});

test('import rules reject runtime cycles', async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), 'golens-import-cycle-'));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'review-session'));
  await writeFile(join(fixture, 'review-session', 'index.ts'), "import './runtime.ts';\n");
  await writeFile(join(fixture, 'review-session', 'runtime.ts'), "import './index.ts';\n");

  assert.throws(() => check(fixture), /Command failed/);
});

test('import rules allow erased type cycles', async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), 'golens-import-type-cycle-'));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'review-session'));
  await writeFile(join(fixture, 'review-session', 'index.ts'), "import type { Runtime } from './runtime.ts';\nexport type Session = Runtime;\n");
  await writeFile(join(fixture, 'review-session', 'runtime.ts'), "import type { Session } from './index.ts';\nexport type Runtime = Session;\n");

  assert.match(check(fixture), /Import rules passed/);
});

test('import rules reject arbitrary root modules', async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), 'golens-import-root-'));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'review-session'));
  await writeFile(join(fixture, 'review-session', 'index.ts'), "import '../rogue.ts';\n");
  await writeFile(join(fixture, 'rogue.ts'), 'export {};\n');

  assert.throws(() => check(fixture), /Command failed/);
});

test('import rules reject unlocked packages', async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), 'golens-import-package-'));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'review-session'));
  await writeFile(join(fixture, 'review-session', 'index.ts'), "import 'not-installed';\n");

  assert.throws(() => check(fixture), /Command failed/);
});
