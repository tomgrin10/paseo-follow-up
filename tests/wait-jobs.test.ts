// Ported from the standalone paseo-wait plugin (tests/jobs.test.ts) when Follow-up absorbed Wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { nodeRuntime } from '../server/job-guard';
import { WaitJobs, waitInput, DEFAULT_WAIT_SECONDS, HARD_MAX_WAIT_SECONDS, DEFAULT_JOB_TIMEOUT_SECONDS, MAX_JOB_TIMEOUT_SECONDS } from '../server/wait-jobs';

async function fixture(runtime?: (directory: string) => ReturnType<typeof nodeRuntime>) {
  const directory = await mkdtemp(join(tmpdir(), 'follow-wait-unit-'));
  const owner = { id: 'test-agent', cwd: directory };
  const jobs = new WaitJobs(directory, null, runtime?.(directory));
  return { directory, owner, jobs, async close() { jobs.close(); await rm(directory, { recursive: true, force: true }); } };
}
function run(command: string) {
  const child = spawn('bash', ['-c', command], { stdio: 'pipe' });
  const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return { child, finished };
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 10_000;
  while (!await access(path).then(() => true, () => false)) {
    assert.ok(Date.now() < deadline, 'the command starts');
    await new Promise(r => setTimeout(r, 25));
  }
}
async function shellEnv(directory: string, noTimeout: boolean) {
  const env = { ...process.env };
  if (noTimeout) {
    // Exercise macOS's runner path on Linux: no timeout or setsid binary on PATH.
    const bin = join(directory, 'bin');
    await mkdir(bin);
    for (const name of ['sh', 'bash', 'mkdir', 'cat', 'mv', 'sleep']) {
      const found = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
      assert.equal(found.status, 0);
      await symlink(found.stdout.trim(), join(bin, name));
    }
    env.PATH = bin;
  }
  return env;
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
      // Signal the runner itself: killing the launcher is shell cleanup and must leave the runner alone.
      const child = spawn('sh', [join(f.directory, 'run-job.sh'), join(f.directory, 'jobs', f.owner.id, job.jobId), f.owner.cwd, `: ${marker}; while :; do sleep 0.2; done`], { stdio: 'ignore', detached: true });
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
      assert.equal(status.timedOut, undefined, 'stopped, not timed out (even where timeout exits 124 on TERM)');
      assert.equal(status.exitCode, 143);
    }
    // The job's stdin is /dev/null: a command that reads it ends instead of hanging.
    const reads = await f.jobs.prepare(f.owner, { description: 'reads stdin', command: 'cat; exit 5', timeoutSeconds: 60 });
    const started = Date.now();
    assert.equal(await run(reads.bashCommand).finished, 5);
    assert.ok(Date.now() - started < 5000);
  } finally { await f.close(); }
});

// A shell tool may kill its entire launch group after returning (Codex exec_command).
// The runner must survive too, not only GNU timeout's separately grouped command.
for (const [shell, native, noTimeout] of [['sh', false, false], ['bash', false, false], ['bash', true, false], ['sh', false, true], ['bash', true, true]] as const) {
  test(`the runner survives ${shell} launch-group cleanup (${native ? 'background Bash' : 'detached'}${noTimeout ? ', without timeout' : ''})`, async () => {
    const f = await fixture();
    const ready = join(f.directory, 'ready');
    const release = join(f.directory, 'release');
    let launcher: ReturnType<typeof spawn> | undefined;
    try {
      const job = await f.jobs.prepare(f.owner, {
        description: 'survive shell cleanup', timeoutSeconds: 5,
        command: `printf ready > '${ready}'; while ! test -e '${release}'; do sleep 0.05; done; printf survived; exit 7`,
      }, native ? 'background-bash' : 'detached');
      const env = await shellEnv(f.directory, noTimeout);
      launcher = spawn(shell, ['-c', job.bashCommand], { detached: true, stdio: 'ignore', env });
      const exited = new Promise(resolve => launcher!.once('exit', resolve));
      if (!native) await exited; // The detached launch command has returned, as in exec_command.
      await waitForFile(ready);
      try { process.kill(-launcher.pid!, 'SIGKILL'); } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH', 'the launch group may already be empty');
      }
      await writeFile(release, 'go');
      const receipt = await f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 2 });
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.exitCode, 7, 'the runner survives and records the actual command exit');
      if (!native) {
        assert.ok(job.outputPath, 'detached jobs expose their output');
        assert.equal(await readFile(job.outputPath, 'utf8'), 'survived');
      }
    } finally {
      await writeFile(release, 'go');
      if (launcher?.pid) { try { process.kill(-launcher.pid, 'SIGKILL'); } catch {} }
      await f.close();
    }
  });
}

for (const appImage of [false, true]) for (const mode of ['background-bash', 'detached'] as const) {
  test(`Wait launches Electron as Node (${appImage ? 'AppImage' : 'desktop'}, ${mode})`, async () => {
    const executable = "Paseo's desktop.AppImage";
    const f = await fixture(directory => nodeRuntime({
      execPath: appImage ? '/runtime/transient/paseo' : join(directory, executable),
      electron: '40.0.0', appImage: appImage ? join(directory, executable) : undefined,
    }));
    try {
      const node = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
      await writeFile(join(f.directory, executable), `#!/bin/sh
[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 91
exec ${node} "$@"
`, { mode: 0o700 });
      const job = await f.jobs.prepare(f.owner, { description: 'desktop runner', command: 'printf desktop; exit 7' }, mode);
      assert.match(job.bashCommand, /^'env' 'ELECTRON_RUN_AS_NODE=1'/);
      assert.equal(await run(job.bashCommand).finished, mode === 'detached' ? 0 : 7);
      const receipt = await f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 5 });
      assert.equal(receipt.exitCode, 7);
      if (mode === 'detached') {
        assert.ok(job.outputPath);
        assert.equal(await readFile(job.outputPath, 'utf8'), 'desktop');
      }
    } finally { await f.close(); }
  });
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) for (const group of [false, true]) for (const noTimeout of [false, true]) {
  test(`native launcher forwards ${signal} (${group ? 'group' : 'process'}${noTimeout ? ', without timeout' : ''})`, async () => {
    const f = await fixture();
    let launcher: ReturnType<typeof spawn> | undefined;
    try {
      const ready = join(f.directory, 'ready'); const stopped = join(f.directory, 'stopped');
      const job = await f.jobs.prepare(f.owner, {
        description: 'native termination', timeoutSeconds: 15,
        command: `trap 'printf stopped > "${stopped}"; exit 143' TERM INT HUP; printf ready > "${ready}"; sleep 8; printf escaped > "${stopped}"`,
      }, 'background-bash');
      launcher = spawn('bash', ['-c', job.bashCommand], { detached: true, stdio: 'ignore', cwd: f.owner.cwd, env: await shellEnv(f.directory, noTimeout) });
      const exited = new Promise<number | null>((resolve, reject) => { launcher!.once('exit', resolve); launcher!.once('error', reject); });
      await waitForFile(ready);
      process.kill(group ? -launcher.pid! : launcher.pid!, signal);
      const receipt = await f.jobs.wait(f.owner, { jobId: job.jobId, max_wait_seconds: 5 });
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.exitCode, noTimeout && signal === 'SIGINT' ? 130 : 143);
      assert.equal(receipt.timedOut, undefined, 'deliberate termination is not a timeout');
      assert.equal(await exited, receipt.exitCode, 'native Bash gets the runner exit');
      await waitForFile(stopped);
      assert.equal(await readFile(stopped, 'utf8'), 'stopped', 'the command receives the signal and exits');
    } finally {
      if (launcher?.pid) { try { process.kill(-launcher.pid, 'SIGKILL'); } catch {} }
      await f.close();
    }
  });
}
