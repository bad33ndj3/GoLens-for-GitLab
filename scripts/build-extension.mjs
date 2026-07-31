import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { watchFile } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArgument = process.argv.indexOf('--root');
const root = rootArgument === -1
  ? join(dirname(fileURLToPath(import.meta.url)), '..')
  : resolve(process.argv[rootArgument + 1]);
const dist = join(root, 'dist');
const output = join(dist, 'extension');
const watchMode = process.argv.includes('--watch');
const contentScript = JSON.parse(await readFile(join(root, 'src/gitlab-host/content-script-registration.json'), 'utf8'));
const staticFiles = [
  'LICENSE', 'PRIVACY.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
  'src/popup.html', 'src/popup.css', 'src/settings.html', 'src/settings.css',
  'src/gitlab-lens.css', 'src/golens-theme.css',
  'assets/icons/golens-16.png', 'assets/icons/golens-32.png',
  'assets/icons/golens-48.png', 'assets/icons/golens-128.png',
  'assets/celebrations/golens-approved.png',
  'assets/celebrations/golens-discussions-resolved.png',
  'assets/celebrations/golens-focus.png',
  'assets/celebrations/golens-friday-beer.png',
  'assets/celebrations/golens-merged.png',
  'assets/celebrations/golens-pitstop.png',
  'vendor/tree-sitter-go.wasm', 'vendor/web-tree-sitter.wasm',
];
const staticTargets = new Map(staticFiles.map((source) => [source, source.startsWith('src/') ? source.slice(4) : source]));

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

function rewriteManifest(manifest) {
  return {
    ...manifest,
    background: { service_worker: 'worker.js', type: 'module' },
    content_scripts: manifest.content_scripts.map((script) => ({
      ...script,
      ...contentScript,
    })),
  };
}

async function validate(directory, allowMaps) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (manifest.version !== packageJson.version || manifest.version !== packageLock.packages[''].version) {
    throw new Error('manifest, package, and lockfile versions differ');
  }

  const expected = new Set(['manifest.json', 'content.js', 'worker.js', 'popup.js', 'settings.js', ...staticTargets.values()]);
  const actual = (await files(directory)).map((file) => relative(directory, file));
  for (const file of actual) {
    if (allowMaps && file.endsWith('.map')) continue;
    if (!expected.has(file)) throw new Error(`unexpected production file: ${file}`);
    if (/\.ts$|\.test\.|(^|\/)tests?\//.test(file)) throw new Error(`source or test shipped: ${file}`);
  }
  for (const file of expected) {
    if (!actual.includes(file)) throw new Error(`missing production file: ${file}`);
  }

  const references = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action.default_icon || {}),
    ...manifest.content_scripts.flatMap((script) => [...script.js, ...script.css]),
    ...manifest.web_accessible_resources.flatMap((resource) => resource.resources),
  ]);
  for (const html of ['popup.html', 'settings.html']) {
    const markup = await readFile(join(directory, html), 'utf8');
    for (const match of markup.matchAll(/(?:href|src)=(['"])([^'"#]+)\1/g)) references.add(match[2]);
    for (const match of markup.matchAll(/srcset=(['"])([^'"]+)\1/g)) {
      for (const candidate of match[2].split(',')) references.add(candidate.trim().split(/\s+/, 1)[0]);
    }
  }
  for (const reference of references) {
    if (!actual.includes(reference)) throw new Error(`missing referenced file: ${reference}`);
  }
}

async function publish(stage) {
  const backup = join(dist, `.extension-backup-${process.pid}`);
  await rm(backup, { recursive: true, force: true });
  try {
    await rename(output, backup);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(stage, output);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rename(backup, output).catch(() => {});
    throw error;
  }
}

async function buildExtension() {
  await mkdir(dist, { recursive: true });
  const stage = join(dist, `.extension-stage-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    const common = {
      bundle: true,
      target: 'es2020',
      platform: 'browser',
      sourcemap: watchMode ? 'external' : false,
      minify: false,
      treeShaking: true,
      outdir: stage,
      logLevel: 'silent',
    };
    await build({ ...common, entryPoints: { content: join(root, 'src/content.ts') }, format: 'iife' });
    await build({
      ...common,
      entryPoints: {
        worker: join(root, 'src/worker.ts'),
        popup: join(root, 'src/popup.ts'),
        settings: join(root, 'src/settings.ts'),
      },
      format: 'esm',
    });
    for (const [source, target] of staticTargets) {
      await mkdir(dirname(join(stage, target)), { recursive: true });
      await cp(join(root, source), join(stage, target));
    }
    const manifest = rewriteManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await validate(stage, watchMode);
    await publish(stage);
    console.log(`Built ${relative(root, output)}.`);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

await buildExtension();
if (watchMode) {
  let timer;
  const watched = new Set();
  let building = false;
  let pending = false;
  async function runRebuild() {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    do {
      pending = false;
      await buildExtension().then(watchInputs).catch((error) => console.error(error.message));
    } while (pending);
    building = false;
  }
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(runRebuild, 50);
  };
  async function watchInputs() {
    const inputs = ['manifest.json', 'package.json', ...staticFiles, ...(await files(join(root, 'src'))).map((file) => relative(root, file))];
    for (const input of inputs) {
      if (watched.has(input)) continue;
      watched.add(input);
      watchFile(join(root, input), { interval: 250 }, rebuild);
    }
  }
  await watchInputs();
  console.log('Watching rewrite sources.');
}
