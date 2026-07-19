import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(rootDirectory, 'manifest.json'), 'utf8'));
const outputDirectory = join(rootDirectory, 'dist');
const outputFile = join(outputDirectory, `golens-for-gitlab-v${manifest.version}.zip`);

const extensionFiles = [
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'manifest.json',
  'shortcut-settings.js',
  'bookmark-store.js',
  'content.js',
  'golens-theme.css',
  'gitlab-lens.css',
  'go-navigation.js',
  'gitlab-host-access.js',
  'go-semantic-cache.js',
  'go-semantic-core.js',
  'go-semantic-worker.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'settings.css',
  'settings.html',
  'settings.js',
  'assets/celebrations',
  'assets/icons',
  'vendor',
];

mkdirSync(outputDirectory, { recursive: true });
rmSync(outputFile, { force: true });

try {
  execFileSync('zip', ['-rq', outputFile, ...extensionFiles], {
    cwd: rootDirectory,
    stdio: 'inherit',
  });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('Packaging requires the zip command to be installed.');
  }
  process.exitCode = 1;
  throw error;
}

console.log(`Created ${outputFile}`);
