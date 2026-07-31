import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'dist', 'extension');

async function files(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory() ? files(join(directory, entry.name), relative) : [relative];
  }));
  return nested.flat().sort();
}

test('production build emits a validated four-entry extension', async () => {
  execFileSync(process.execPath, ['scripts/build-extension.mjs'], { cwd: root });

  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'worker.js');
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
  assert.match(await readFile(join(extension, 'popup.html'), 'utf8'), /<script type="module" src="popup\.js"><\/script>/);
  assert.match(await readFile(join(extension, 'settings.html'), 'utf8'), /<script type="module" src="settings\.js"><\/script>/);
  const settings = await readFile(join(extension, 'settings.js'), 'utf8');
  assert.match(settings, /registerContentScripts/);
  for (const file of [...manifest.content_scripts[0].js, ...manifest.content_scripts[0].css]) {
    assert.match(settings, new RegExp(file.replaceAll('.', '\\.')));
  }

  const output = await files(extension);
  assert.ok(output.includes('content.js'));
  assert.ok(output.includes('worker.js'));
  assert.ok(output.includes('popup.js'));
  assert.ok(output.includes('settings.js'));
  assert.equal(output.some((file) => /(?:\.ts|\.map|\.test\.)$/.test(file)), false);
});

test('failed production build preserves the last valid artifact', async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), 'golens-build-failure-'));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'dist', 'extension'), { recursive: true });
  await writeFile(join(fixture, 'dist', 'extension', 'last-valid'), 'kept');

  assert.throws(() => execFileSync(process.execPath, ['scripts/build-extension.mjs', '--root', fixture], {
    cwd: root,
    stdio: 'ignore',
  }));
  assert.equal(await readFile(join(fixture, 'dist', 'extension', 'last-valid'), 'utf8'), 'kept');
});
