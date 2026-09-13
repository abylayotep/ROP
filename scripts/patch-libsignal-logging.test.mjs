import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'patch-libsignal-logging.mjs');
const sensitiveCalls = [
  'console.warn("Session already closed", session);',
  'console.info("Closing session:", session);',
  'console.info("Opening session:", session);',
  'console.info("Removing old closed session:", oldestSession);',
];

async function fixture(source) {
  const root = await mkdtemp(join(tmpdir(), 'libsignal-log-patch-'));
  const target = join(root, 'node_modules/libsignal/src/session_record.js');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
  return { root, target };
}

test('removes session-object logs while preserving unrelated console output', async () => {
  const original = `${sensitiveCalls.join('\n')}\nconsole.info("Safe diagnostic");\n`;
  const { root, target } = await fixture(original);
  try {
    const first = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const patched = await readFile(target, 'utf8');
    for (const call of sensitiveCalls) assert.equal(patched.includes(call), false);
    assert.equal(patched.includes('console.info("Safe diagnostic");'), true);

    const second = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(target, 'utf8'), patched);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when the dependency source no longer matches the audited version', async () => {
  const { root } = await fixture('console.info("Dependency changed");\n');
  try {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected libsignal logging statement/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
