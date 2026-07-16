import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function releaseFixture({ branch = 'main', pushFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'golens-release-'));
  const scripts = join(root, 'scripts');
  const bin = join(root, 'bin');
  const commandLog = join(root, 'commands.log');
  await mkdir(scripts);
  await mkdir(bin);
  await copyFile(join(repositoryRoot, 'scripts/release-extension.mjs'), join(scripts, 'release-extension.mjs'));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(bin, 'git'), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  "status --porcelain") ;;
  "branch --show-current") printf '%s\\n' "$FAKE_BRANCH" ;;
  "rev-parse HEAD"|"rev-parse @{upstream}") printf '%s\\n' 'abc123' ;;
  "tag --annotate v1.2.3 --message GoLens for GitLab v1.2.3 abc123") ;;
  "push origin refs/tags/v1.2.3") [ "$FAKE_PUSH_FAILS" != 'true' ] ;;
  "tag --delete v1.2.3") ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  await writeFile(join(bin, 'npm'), `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$COMMAND_LOG"
`, { mode: 0o755 });
  await writeFile(join(bin, 'gh'), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$COMMAND_LOG"
exit 65
`, { mode: 0o755 });

  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: commandLog,
    FAKE_BRANCH: branch,
    FAKE_PUSH_FAILS: String(pushFails),
  };

  return {
    root,
    commandLog,
    run() {
      return execFileSync(process.execPath, [join(scripts, 'release-extension.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: environment,
      });
    },
  };
}

test('release command pushes a tag and leaves release creation to GitHub Actions', async (context) => {
  const fixture = await releaseFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const output = fixture.run();
  const commands = await readFile(fixture.commandLog, 'utf8');

  assert.match(output, /GitHub Actions will validate and publish the release/);
  assert.match(commands, /git tag --annotate v1\.2\.3/);
  assert.match(commands, /git push origin refs\/tags\/v1\.2\.3/);
  assert.doesNotMatch(commands, /^gh /m);
  assert.doesNotMatch(commands, /npm run package/);
});

test('release command rejects a tag from outside main before publishing', async (context) => {
  const fixture = await releaseFixture({ branch: 'feature' });
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  assert.throws(() => fixture.run(), /Command failed/);
  const commands = await readFile(fixture.commandLog, 'utf8');
  assert.doesNotMatch(commands, /git tag /);
  assert.doesNotMatch(commands, /git push /);
  assert.doesNotMatch(commands, /^npm /m);
});

test('release command removes its local tag when pushing fails', async (context) => {
  const fixture = await releaseFixture({ pushFails: true });
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  assert.throws(() => fixture.run(), /Command failed/);
  const commands = await readFile(fixture.commandLog, 'utf8');
  assert.match(commands, /git push origin refs\/tags\/v1\.2\.3/);
  assert.match(commands, /git tag --delete v1\.2\.3/);
  assert.doesNotMatch(commands, /^gh /m);
});
