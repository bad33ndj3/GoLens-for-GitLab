import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(rootDirectory, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(join(rootDirectory, 'package.json'), 'utf8'));

function run(command, arguments_, options = {}) {
  const output = execFileSync(command, arguments_, {
    cwd: rootDirectory,
    encoding: 'utf8',
    ...options,
  });

  return typeof output === 'string' ? output.trim() : '';
}

function fail(message) {
  console.error(`Release aborted: ${message}`);
  process.exit(1);
}

if (manifest.version !== packageJson.version) {
  fail(`manifest version ${manifest.version} does not match package version ${packageJson.version}.`);
}

if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
  fail(`manifest version ${manifest.version} is not a valid Chrome extension version.`);
}

if (run('git', ['status', '--porcelain'])) {
  fail('commit or stash all working-tree changes first.');
}

const commit = run('git', ['rev-parse', 'HEAD']);
let upstreamCommit;

try {
  upstreamCommit = run('git', ['rev-parse', '@{upstream}']);
} catch {
  fail('the current branch does not have an upstream branch. Push it first.');
}

if (commit !== upstreamCommit) {
  fail('the current commit has not been pushed to its upstream branch.');
}

run('npm', ['run', 'check'], { stdio: 'inherit' });
run('npm', ['run', 'package'], { stdio: 'inherit' });

const tag = `v${manifest.version}`;
const archive = join(rootDirectory, 'dist', `golens-for-gitlab-${tag}.zip`);

if (!existsSync(archive)) {
  fail(`expected package was not created at ${archive}.`);
}

run('gh', [
  'release',
  'create',
  tag,
  archive,
  '--target',
  commit,
  '--title',
  `GoLens for GitLab ${tag}`,
  '--generate-notes',
], { stdio: 'inherit' });

console.log(`Published GitHub release ${tag} with ${archive}`);
