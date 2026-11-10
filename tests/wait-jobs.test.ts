// Ported from the standalone paseo-wait plugin (tests/jobs.test.ts) when Follow-up absorbed Wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WaitJobs, waitInput, DEFAULT_WAIT_SECONDS, HARD_MAX_WAIT_SECONDS, DEFAULT_JOB_TIMEOUT_SECONDS, MAX_JOB_TIMEOUT_SECONDS } from '../server/wait-jobs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'follow-wait-unit-'));
  const owner = { id: 'test-agent', cwd: directory };
  const jobs = new WaitJobs(directory);
  return { directory, owner, jobs, async close() { jobs.close(); await rm(directory, { recursive: true, force: true }); } };
}
function run(command: string) {
  const child = spawn('bash', ['-c', command], { stdio: 'pipe' });
  const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return { child, finished };
}

test('a finite job periodically wakes the caller, completes, and survives store recreation', async () => {
  const f = await fixture();
  try {
    const prepared = await f.jobs.prepare(f.owner, { description: 'finite verification', command: 'sleep 2.4; printf verified' });
    assert.equal((await f.jobs.status(f.owner, prepared.jobId)).status, 'prepared');
    const execution = run(prepared.bashCommand);
    const first = await f.jobs.wait(f.owner, { jobId: prepared.jobId, max_wait_seconds: 1 });
    assert.equal(first.outcome, 'still_pending'); assert.match(first.instruction, /Inspect/); assert.ok(first.waitedSeconds < 1.5);
    const second = await f.jobs.wait(f.owner, { jobId: prepared.jobId, max_wait_seconds: 1 });
    assert.equal(second.outcome, 'still_pending');
    const third = await f.jobs.wait(f.owner, { jobId: prepared.jobId, max_wait_seconds: 1 });
    assert.equal(third.outcome, 'completed'); assert.equal(third.exitCode, 0);
    assert.equal(await execution.finished, 0);
    assert.equal(f.jobs.activeWaits, 0);
    f.jobs.close();
    const restored = new WaitJobs(f.directory);
    assert.equal((await restored.status(f.owner, prepared.jobId)).status, 'completed'); restored.close();
  } finally { await f.close(); }
});

test('ceilings are fixed, strict, and cannot be extended by a hung message transport', async () => {
  assert.equal(DEFAULT_WAIT_SECONDS, 30); assert.equal(HARD_MAX_WAIT_SECONDS, 60);
  const f = await fixture();
  try {
    const job = await f.jobs.prepare(f.owner, { description: 'not started', command: 'true' });
    assert.equal(waitInput.parse({ jobId: job.jobId }).max_wait_seconds, 30);
    for (const max_wait_seconds of [0, -1, 61, 3600, 1.5]) assert.throws(() => waitInput.parse({ jobId: job.jobId, max_wait_seconds }));
    const start = Date.now();
    const receipt = await f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 1 }, { hasNewMessage: () => new Promise(() => {}) });
    assert.equal(receipt.outcome, 'still_pending'); assert.equal(receipt.status, 'prepared'); assert.ok(Date.now() - start < 1500); assert.equal(f.jobs.activeWaits, 0);
  } finally { await f.close(); }
});

test('native shell quoting preserves the command, failure exit codes, and single execution', async () => {
  const f = await fixture();
  try {
    const marker = join(f.directory, 'quoted.txt');
    const job = await f.jobs.prepare(f.owner, { description: 'failure receipt', command: `printf '%s' "a'b $ literal" > '${marker}'; exit 7` });
    assert.equal(await run(job.bashCommand).finished, 7);
    assert.equal(await readFile(marker, 'utf8'), "a'b $ literal");
    const receipt = await f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 1 });
    assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.exitCode, 7);
    assert.equal(await run(job.bashCommand).finished, 125);
    assert.equal((await f.jobs.status(f.owner, job.jobId)).exitCode, 7);
  } finally { await f.close(); }
});

test('new messages and cancellation end observation without inventing completion', async () => {
  const f = await fixture();
  try {
    const job = await f.jobs.prepare(f.owner, { description: 'waiting', command: 'true' });
    const controller = new AbortController();
    const waiting = f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 60 }, { signal: controller.signal });
    Reflect.apply(controller.abort, controller, [new Error('user stop')]);
    await assert.rejects(waiting, /user stop/);
    const next = await f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 60 }, { hasNewMessage: async () => true });
    assert.equal(next.outcome, 'new_message'); assert.equal(next.status, 'prepared');
    assert.equal((await f.jobs.status(f.owner, job.jobId)).status, 'prepared');
    const reloadWait = f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 60 });
    f.jobs.close(); await assert.rejects(reloadWait, /preserved/); assert.equal(f.jobs.activeWaits, 0);
  } finally { await f.close(); }
});

test('ownership, invalid receipts, and symlinked receipts cannot report success', async () => {
  const f = await fixture();
  try {
    const job = await f.jobs.prepare(f.owner, { description: 'owned', command: 'true' });
    await assert.rejects(f.jobs.status({ ...f.owner, id: 'other-agent' }, job.jobId), /Unknown job/);
    await assert.rejects(f.jobs.status({ ...f.owner, cwd: '/different' }, job.jobId), /ownership/);
    await assert.rejects(f.jobs.status({ ...f.owner, id: '../escape' }, job.jobId), /identity/);
    const receipt = join(f.directory, 'jobs', f.owner.id, job.jobId, 'result.json');
    await writeFile(receipt, '{"exitCode":"0"}'); await assert.rejects(f.jobs.status(f.owner, job.jobId));
    await rm(receipt); const outside = join(f.directory, 'outside.json'); await writeFile(outside, '{"exitCode":0}'); await symlink(outside, receipt);
    await assert.rejects(f.jobs.status(f.owner, job.jobId), /Invalid wait job/);
  } finally { await f.close(); }
});

test('a prepared job stops at its time limit and its receipt says it timed out', async () => {
  const f = await fixture();
  try {
    assert.equal(DEFAULT_JOB_TIMEOUT_SECONDS, 3 * 3600); assert.equal(MAX_JOB_TIMEOUT_SECONDS, 12 * 3600);
    await assert.rejects(f.jobs.prepare(f.owner, { description: 'too long', command: 'true', timeoutSeconds: MAX_JOB_TIMEOUT_SECONDS + 1 }));
    // The VM sleep report's case: a poll loop whose marker never comes.
    const loop = await f.jobs.prepare(f.owner, { description: 'endless poll', command: 'while ! grep -q EXIT /nonexistent 2>/dev/null; do sleep 0.2; done', timeoutSeconds: 1 });
    const started = Date.now();
    assert.equal(await run(loop.bashCommand).finished, 124);
    assert.ok(Date.now() - started < 5000, 'stopped at the limit, not left running');
    const receipt = await f.jobs.wait(f.owner, { jobId: loop.jobId, max_wait_seconds: 1 });
    assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.exitCode, 124); assert.equal(receipt.timedOut, true);
    assert.match(receipt.instruction, /time limit/);
    const quick = await f.jobs.prepare(f.owner, { description: 'quick', command: 'exit 3' });
    assert.equal(await run(quick.bashCommand).finished, 3);
    const status = await f.jobs.status(f.owner, quick.jobId);
    assert.equal(status.exitCode, 3); assert.equal(status.timedOut, undefined, 'an ordinary failure is not a timeout');
  } finally { await f.close(); }
});

// Stop or Claude Code's background-task kill signals the runner, or its whole process group. GNU timeout moves the
// job into a group of its own, so the runner must pass the signal on: no job process may outlive it.
test('a TERM to the runner, or to its process group, stops the timed job and still writes a receipt', async () => {
  const f = await fixture();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const gone = async (marker: string) => {
    for (let i = 0; i < 50; i++) {
      const left = await new Promise<string>(ok => { const p = spawn('pgrep', ['-f', marker]); let out = ''; p.stdout.on('data', c => out += c); p.once('exit', () => ok(out.trim())); });
      if (!left) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };
  try {
    for (const target of ['runner', 'group'] as const) {
      const marker = `follow-wait-term-${target}-${process.pid}`;
      const job = await f.jobs.prepare(f.owner, { description: target, command: `: ${marker}; while :; do sleep 0.2; done`, timeoutSeconds: 600 });
      // detached: the runner leads its own process group, as under Claude Code's background Bash.
      const child = spawn('bash', ['-c', job.bashCommand], { stdio: 'ignore', detached: true });
      const exited = new Promise<number | null>(ok => child.once('exit', (code, signal) => ok(code ?? (signal ? 128 : null))));
      while (!(await readFile(join(f.directory, 'jobs', f.owner.id, job.jobId, 'started'), 'utf8').then(() => true, e => e.code === 'EISDIR'))) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 300));
      process.kill(target === 'runner' ? child.pid! : -child.pid!, 'SIGTERM');
      const ended = await Promise.race([exited.then(() => true), new Promise<false>(r => setTimeout(() => r(false), 10_000))]);
      if (!ended) { spawn('pkill', ['-f', marker]); try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
      assert.ok(ended, `${target}: the runner ends on TERM`);
      assert.ok(await gone(marker), `${target}: no job process left behind`);
      assert.equal(alive(child.pid!), false);
      const status = await f.jobs.status(f.owner, job.jobId);
      assert.equal(status.status, 'failed', `${target}: the receipt is written`);
      assert.equal(status.timedOut, undefined, 'stopped, not timed out');
    }
    // The job's stdin is /dev/null: a command that reads it ends instead of hanging.
    const reads = await f.jobs.prepare(f.owner, { description: 'reads stdin', command: 'cat; exit 5', timeoutSeconds: 60 });
    const started = Date.now();
    assert.equal(await run(reads.bashCommand).finished, 5);
    assert.ok(Date.now() - started < 5000);
  } finally { await f.close(); }
});
