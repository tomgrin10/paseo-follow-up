// Ported from the standalone paseo-wait plugin (tests/jobs.test.ts) when Follow-up absorbed Wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WaitJobs, waitInput, DEFAULT_WAIT_SECONDS, HARD_MAX_WAIT_SECONDS, JOB_RETENTION_MS } from '../server/wait-jobs';

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

test('the runner passes output through unchanged and live, keeps exit codes, and bounds its copy to ~1 MiB', async () => {
  const f = await fixture();
  try {
    for (const code of [0, 1, 7, 255]) {
      const job = await f.jobs.prepare(f.owner, { description: `exit ${code}`, command: `printf 'out\\n'; printf 'err\\n' >&2; exit ${code}` });
      const execution = run(job.bashCommand);
      let seen = ''; execution.child.stdout.on('data', chunk => { seen += chunk; }); execution.child.stderr.on('data', chunk => { seen += chunk; });
      assert.equal(await execution.finished, code, 'the runner exits with the command\'s own code');
      assert.equal(seen, 'out\nerr\n', 'the agent\'s Bash gets the same bytes');
      assert.equal((await f.jobs.status(f.owner, job.jobId)).exitCode, code);
      assert.equal((await f.jobs.outputTail(f.owner.id, job.jobId)).text, 'out\nerr\n');
    }
    // Live: the first line reaches the agent's Bash (and the copy) before the command exits.
    const slow = await f.jobs.prepare(f.owner, { description: 'live', command: 'echo first; sleep 2; echo second' });
    const live = run(slow.bashCommand);
    const first = await new Promise<number>(resolve => live.child.stdout.once('data', () => resolve(Date.now())));
    const ended = await live.finished.then(() => Date.now());
    assert.ok(ended - first > 1500, 'output streams as it is written, not at exit');
    // Bounded: 3 MiB of output leaves at most two 512 KiB halves, ending with the last line.
    const chatty = await f.jobs.prepare(f.owner, { description: 'chatty', command: "head -c 3145728 /dev/zero | tr '\\0' 'x' | fold -w 1023; echo LAST" });
    const big = run(chatty.bashCommand);
    let total = 0; big.child.stdout.on('data', chunk => { total += chunk.length; });
    assert.equal(await big.finished, 0);
    assert.ok(total > 3145728, 'the agent still gets everything');
    const tail = await f.jobs.outputTail(f.owner.id, chatty.jobId);
    assert.ok(tail.bytes <= 1048576, `the copy holds ${tail.bytes} bytes`); assert.ok(tail.truncated);
    assert.ok(tail.text.endsWith('LAST\n')); assert.ok(Buffer.byteLength(tail.text) <= 8192);
    assert.ok(!tail.text.startsWith('x'.repeat(1023) + 'x'), 'the tail starts on a line boundary');
    await assert.rejects(f.jobs.outputTail('other-agent', chatty.jobId), /Unknown job/);
  } finally { await f.close(); }
});

test('prepare prunes job directories untouched for 7 days, at most once an hour', async () => {
  const f = await fixture();
  try {
    const old = await f.jobs.prepare(f.owner, { description: 'old', command: 'true' });
    const fresh = await f.jobs.prepare(f.owner, { description: 'fresh', command: 'true' });
    const { utimes } = await import('node:fs/promises');
    const stale = new Date(Date.now() - JOB_RETENTION_MS - 60_000);
    await utimes(join(f.directory, 'jobs', f.owner.id, old.jobId, 'job.json'), stale, stale);
    assert.equal(await f.jobs.prune(Date.now() + 7200_000), 1);
    await assert.rejects(f.jobs.status(f.owner, old.jobId), /Unknown job/);
    assert.equal((await f.jobs.status(f.owner, fresh.jobId)).status, 'prepared');
    assert.equal(await f.jobs.prune(Date.now() + 7300_000), 0, 'the next sweep waits an hour');
  } finally { await f.close(); }
});
