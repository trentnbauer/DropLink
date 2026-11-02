import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/next-version.sh', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ver-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
const pkg = (v) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: v }));
const run = (...a) => Object.fromEntries(execFileSync('sh', [script, ...a], { cwd: dir, encoding: 'utf8' }).trim().split('\n').map((l) => l.split('=')));

pkg('0.3.0');
git('init', '-q');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

test('numbers every merge to main automatically', () => {
  assert.equal(run('push', 'branch', 'main', 'abcdef1').version, '0.3.0');
  git('tag', 'v0.3.0');
  assert.equal(run('push', 'branch', 'main', 'abcdef1').version, '0.3.1');
  for (const t of ['v0.3.9', 'v0.3.10', 'v0.30.4', 'v1.0.0']) git('tag', t);
  assert.equal(run('push', 'branch', 'main', 'abcdef1').version, '0.3.11', 'sorts numerically and ignores other minors');
  pkg('0.4.0');
  assert.equal(run('push', 'branch', 'main', 'abcdef1').version, '0.4.0', 'editing package.json bumps the minor');
  assert.equal(run('push', 'branch', 'main', 'abcdef1').release, 'true');
});

test('release tags, pre-releases and pull requests', () => {
  assert.deepEqual(run('push', 'tag', 'v2.1.5', 'abcdef1'), { version: '2.1.5', minor: '2.1', major: '2', stable: 'true', release: 'false' });
  assert.equal(run('push', 'tag', 'v2.0.0-rc.1', 'abcdef1').stable, 'false');
  const pr = run('pull_request', 'branch', '7/merge', 'abcdef1234');
  assert.equal(pr.version, 'dev-abcdef1');
  assert.equal(pr.release, 'false');
});
