// Ported from the standalone paseo-wait plugin (tests/jobs.test.ts) when Follow-up absorbed Wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WaitJobs, waitInput, DEFAULT_WAIT_SECONDS, HARD_MAX_WAIT_SECONDS } from '../server/wait-jobs';

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
  assert.equal(DEFAULT_WAIT_SECONDS, 60); assert.equal(HARD_MAX_WAIT_SECONDS, 180);
  const f = await fixture();
  try {
    const job = await f.jobs.prepare(f.owner, { description: 'not started', command: 'true' });
    assert.equal(waitInput.parse({ jobId: job.jobId }).max_wait_seconds, 60);
    assert.equal(waitInput.parse({ jobId: job.jobId, max_wait_seconds: 180 }).max_wait_seconds, 180);
    for (const max_wait_seconds of [0, -1, 181, 3600, 1.5]) assert.throws(() => waitInput.parse({ jobId: job.jobId, max_wait_seconds }));
    const start = Date.now();
    const receipt = await f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 1 }, { hasNewMessage: () => new Promise(() => {}) });
    assert.equal(receipt.outcome, 'still_pending'); assert.equal(receipt.status, 'prepared'); assert.ok(Date.now() - start < 1500); assert.equal(f.jobs.activeWaits, 0);
  } finally { await f.close(); }
});

test('a full 180 s wait still releases within about a second of a new message', async () => {
  const f = await fixture();
  try {
    const job = await f.jobs.prepare(f.owner, { description: 'long wait', command: 'sleep 600' });
    const start = Date.now();
    let arrived = 0;
    setTimeout(() => { arrived = Date.now(); }, 300);
    const receipt = await f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: HARD_MAX_WAIT_SECONDS }, { hasNewMessage: async () => arrived > 0 });
    assert.equal(receipt.outcome, 'new_message');
    assert.ok(Date.now() - arrived < 1000, `released ${Date.now() - arrived} ms after the message`);
    assert.ok(Date.now() - start < 2000); assert.equal(f.jobs.activeWaits, 0);
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
