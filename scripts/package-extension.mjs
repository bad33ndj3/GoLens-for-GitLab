import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(rootDirectory, 'manifest.json'), 'utf8'));
const outputDirectory = join(rootDirectory, 'dist');
const outputFile = join(outputDirectory, `golens-for-gitlab-v${manifest.version}.zip`);

const extensionFiles = [
  'manifest.json',
  'content.js',
  'gitlab-lens.css',
  'go-navigation.js',
  'go-semantic-cache.js',
  'go-semantic-core.js',
  'go-semantic-worker.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'assets/golens-icon.png',
  'assets/golens-eyestrain.png',
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
