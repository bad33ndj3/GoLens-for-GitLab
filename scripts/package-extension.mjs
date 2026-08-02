import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = join(rootDirectory, 'dist', 'extension');
const manifest = JSON.parse(readFileSync(join(extensionDirectory, 'manifest.json'), 'utf8'));
const outputDirectory = join(rootDirectory, 'dist');
const outputFile = join(outputDirectory, `golens-for-gitlab-v${manifest.version}.zip`);

mkdirSync(outputDirectory, { recursive: true });
rmSync(outputFile, { force: true });

try {
  execFileSync('zip', ['-rq', outputFile, '.'], {
    cwd: extensionDirectory,
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
