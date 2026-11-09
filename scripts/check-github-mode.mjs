// Plain-GitHub mode end to end on the isolated preview (npm run preview first): a fresh install with no Graphite
// sign-in, a fake `gh` that keeps PR state, one PR walked from open to review, ready, auto-merge and merge, and a
// 2-PR base-chain stack merged bottom to top with the child retargeted. Then the same repository in Graphite mode.
// Screenshots (synthetic data) of the panel and PR sheet, desktop and phone, dark and light, go to
// $FOLLOW_SHOTS (default docs/screenshots/github-mode). Needs SEND_TO_PASEO_SOURCE for playwright-core.
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
const exec = promisify(execFile);
const preview = JSON.parse(await readFile('.preview-isolated.json', 'utf8'));
assert.ok(preview.root.startsWith('/tmp/follow-install-') && preview.home === preview.root + '/home', 'Requires the isolated preview.');
const shots = process.env.FOLLOW_SHOTS ?? 'docs/screenshots/github-mode';
await mkdir(shots, { recursive: true });
const env = { ...process.env, HOME: preview.home, XDG_CONFIG_HOME: preview.home + '/.config', PASEO_HOME: preview.home, PASEO_DAEMON_URL: `ws://127.0.0.1:${preview.port}/ws` };
for (const key of ['PASEO_PASSWORD', 'PASEO_PASSWORD_FILE', 'PASEO_AGENT_ID', 'NODE_OPTIONS']) delete env[key];
// A fresh machine: no Graphite sign-in in the isolated home.
await assert.rejects(access(join(preview.home, '.config/graphite/auth')));

// ── Fake GitHub: PR state in a JSON file; reads answer the GraphQL query, writes change the file and are logged. ──
const fixture = join(preview.home, 'github-fixture.json');
const writes = join(preview.home, 'github-writes.log');
const pr = (number, title, headRefName, baseRefName, patch = {}) => ({ number, title, url: `https://github.com/example/app/pull/${number}`, state: 'OPEN', headRefName, headRefOid: `head-${number}`, baseRefName, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', autoMergeRequest: null, isInMergeQueue: false, author: { login: 'dev' }, reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [{ requestedReviewer: { __typename: 'User', login: 'reviewer' } }] }, latestReviews: { pageInfo: { hasNextPage: false }, nodes: [] }, baseRef: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [] }, ...patch });
const initial = { repo: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, autoMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH' }, prs: {
  21: pr(21, 'Tidy the vendor settings copy', 'tidy-copy', 'main'),
  22: pr(22, 'Add vendor aliases table', 'vendor-aliases', 'main', { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }),
  23: pr(23, 'Resolve vendor aliases in search', 'alias-search', 'vendor-aliases', { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }),
  // Left by the install suite in the same preview workspace: shown as earlier, merged work.
  1: pr(1, 'Record migration rollout versions', 'fixture-bottom', 'main', { state: 'MERGED', mergedAt: '2026-11-01T10:00:00Z', mergeCommit: { oid: 'merge-1' } }),
  99: pr(99, 'Backfill rollout audit rows', 'fixture-99', 'main', { state: 'MERGED', mergedAt: '2026-11-01T11:00:00Z', mergeCommit: { oid: 'merge-99' } }),
} };
await writeFile(fixture, JSON.stringify(initial));
await writeFile(writes, '');
const gh = `#!/usr/bin/env node
const fs = require('fs'); const file = ${JSON.stringify(fixture)}; const log = ${JSON.stringify(writes)};
const d = JSON.parse(fs.readFileSync(file, 'utf8')); const a = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(d));
if (process.env.GH_REPO !== 'example/app') { console.error('wrong repo'); process.exit(1); }
if (a[0] === 'pr' && a[1] === 'merge') {
  fs.appendFileSync(log, a.join(' ') + '\\n'); const p = d.prs[a[2]];
  const head = a[a.indexOf('--match-head-commit') + 1];
  if (a.includes('--disable-auto')) { p.autoMergeRequest = null; save(); process.exit(0); }
  if (head && head !== p.headRefOid) { console.error('GraphQL: Head branch was modified. Review and try the merge again.'); process.exit(1); }
  if (a.includes('--auto')) { p.autoMergeRequest = { enabledAt: new Date().toISOString() }; save(); process.exit(0); }
  if (p.baseRefName !== 'main' && d.prs[Object.keys(d.prs).find(k => d.prs[k].headRefName === p.baseRefName)]?.state === 'MERGED') { console.error('GraphQL: Base branch was merged; retarget first'); process.exit(1); }
  p.state = 'MERGED'; p.mergedAt = new Date().toISOString(); p.mergeCommit = { oid: 'merge-' + a[2] }; save(); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'edit') { fs.appendFileSync(log, a.join(' ') + '\\n'); d.prs[a[2]].baseRefName = a[a.indexOf('--base') + 1]; save(); process.exit(0); }
if (a[0] !== 'api' || a[1] !== 'graphql') { console.log('[]'); process.exit(0); }
const query = a.find(x => x.startsWith('query='));
const r = { defaultBranchRef: { name: 'main', branchProtectionRule: null }, ...d.repo, mergeQueue: null };
for (const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)) r[m[1]] = d.prs[m[2]] ?? null;
console.log(JSON.stringify({ data: { repository: r } }));
`;
await writeFile(join(preview.root, 'bin/gh'), gh); await chmod(join(preview.root, 'bin/gh'), 0o700);
const mutate = async change => { const d = JSON.parse(await readFile(fixture, 'utf8')); change(d); await writeFile(fixture, JSON.stringify(d)); };
const logged = async () => (await readFile(writes, 'utf8')).trim().split('\n').filter(Boolean);

const client = new DaemonClient({ url: env.PASEO_DAEMON_URL, clientId: 'github-mode-test', clientType: 'cli', reconnect: { enabled: false } }); await client.connect();
const call = (name, input = {}) => client.invokePluginRpc('follow-through', name, input);
// Refresh runs in the background: wait until every PR was observed after the call.
const refresh = async () => {
  const since = new Date().toISOString();
  await call('follow.refresh', { workspaceId: preview.workspaceId });
  for (let i = 0; i < 60; i++) {
    const w = (await call('follow.get', { workspaceId: preview.workspaceId })).workspace;
    if (w.prs.every(p => p.error || (p.snapshot && p.snapshot.observedAt >= since))) return w;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('PRs were not observed after refresh');
};
const errors = [];
try {
  await call('follow.activate', { workspaceId: preview.workspaceId });
  await call('follow.control', { workspaceId: preview.workspaceId, enable_auto_sends: false });
  for (const n of [21, 22]) await call('follow.register-pr', { agentId: preview.agentId, repo: 'example/app', number: n, stack: n === 21 ? 'Settings copy' : 'Vendor aliases', parentNumber: null });
  // #23 is registered without a parent: its base branch is #22's head, so the stack comes from the base chain.
  await call('follow.register-pr', { agentId: preview.agentId, repo: 'example/app', number: 23, stack: 'Vendor aliases', parentNumber: null });

  await call('follow.set-pr-workflow', { repo: 'example/app', setting: null });
  // ── Auto resolves to GitHub (no sign-in), with a reason that doesn't mention Graphite.
  const view = await call('follow.pr-workflow', { refresh: true });
  const row = view.repos.find(r => r.repo === 'example/app');
  assert.equal(row?.effective, 'github'); assert.equal(row.setting, 'auto'); assert.doesNotMatch(row.reason, /graphite/i);
  assert.equal(view.gt.signedIn, false);

  let w = await refresh();
  const byNumber = n => w.prs.find(p => p.number === n);
  assert.equal(byNumber(21).snapshot.prWorkflow, 'github');
  assert.equal(byNumber(23).parent, 'example/app#22', 'stack inferred from the base chain');
  assert.ok(byNumber(21).snapshot.graphiteMergeStatus === null);

  // ── #21 in review: Merge isn't offered and the reason is GitHub's.
  let plan = await call('follow.prepare-pr-action', { workspaceId: preview.workspaceId, prKey: 'example/app#21', kind: 'merge' });
  assert.ok(plan.prs[0].blockers.includes('Awaiting approval')); assert.ok(plan.prs[0].blockers.every(b => !/graphite/i.test(b)));
  // Approved, but GitHub still says BLOCKED (a ruleset): named as such.
  await mutate(d => { d.prs[21].reviewDecision = 'APPROVED'; });
  w = await refresh();
  plan = await call('follow.prepare-pr-action', { workspaceId: preview.workspaceId, prKey: 'example/app#21', kind: 'merge' });
  assert.deepEqual(plan.prs[0].blockers, ['GitHub says branch protection or a ruleset blocks it']);
  // Ready: GitHub reports CLEAN.
  await mutate(d => { d.prs[21].mergeStateStatus = 'CLEAN'; });
  w = await refresh();

  // ── Screens before acting: panel + PR sheet (#21 ready, Auto-merge switch), desktop/phone × dark/light.
  const { chromium } = createRequire(process.env.SEND_TO_PASEO_SOURCE + '/extension/package.json')('playwright-core');
  const profile = await mkdtemp(join(tmpdir(), 'follow-github-browser-'));
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.STP_CHROMIUM, headless: true, viewport: { width: 1440, height: 1000 }, args: ['--disable-extensions', '--no-first-run'] });
  context.on('weberror', e => errors.push(String(e.error()).slice(0, 300)));
  try {
    const page = await context.newPage();
    await fetch(`http://127.0.0.1:${preview.port}/llms.txt`);
    const open = async () => {
      await page.goto(`http://127.0.0.1:${preview.port}/`);
      await page.getByText('Follow-through POC test', { exact: true }).first().click();
      // The sidebar's Follow-up row opens Home; the workspace header's button (the last one) docks its panel.
      await page.waitForTimeout(2000);
      // The panel stays docked across reloads; the header button toggles it, so press it only when it's closed.
      if (!await page.getByText('Tidy the vendor settings copy').first().isVisible()) await page.getByRole('button', { name: 'Follow-up', exact: true }).last().click();
      await page.getByText('Tidy the vendor settings copy').first().waitFor({ timeout: 30000 });
    };
    const capture = async (name, mobile) => {
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(shots, `${name}-${mobile ? 'phone' : 'desktop'}-${scheme}.png`) });
      }
    };
    for (const mobile of [false, true]) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await open();
      if (mobile) {
        await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(800);
        if (!await page.getByText('Tidy the vendor settings copy').first().isVisible()) await page.getByRole('button', { name: 'Open Explorer sidebar' }).first().click();
        await page.getByText('Tidy the vendor settings copy').first().waitFor({ timeout: 15000 });
      }
      await capture('panel', mobile);
      await page.getByRole('button', { name: new RegExp('^Pull request 21: ') }).first().click();
      await page.getByText('Auto-merge').first().waitFor();
      assert.equal(await page.getByText('Open in Graphite').count(), 0, 'no Graphite link in GitHub mode');
      assert.equal(await page.getByRole('dialog').getByText(/graphite/i).count(), 0, 'nothing on the sheet mentions Graphite');
      await capture('pr-sheet', mobile);
      await page.getByRole('button', { name: 'Merge #21' }).first().click();
      await page.getByText(/GitHub will squash and merge/).first().waitFor();
      await capture('merge-confirm', mobile);
      await page.keyboard.press('Escape');
    }

    // ── Auto-merge on, then off, through the same plan/confirm path the switch uses.
    plan = await call('follow.prepare-pr-action', { workspaceId: preview.workspaceId, prKey: 'example/app#21', kind: 'enable_mwr' });
    assert.equal((await call('follow.confirm-pr-action', { planId: plan.id, scope: 'target' })).state, 'submitted');
    w = await refresh(); assert.equal(byNumber(21).snapshot.mergeWhenReady, 'on');
    plan = await call('follow.prepare-pr-action', { workspaceId: preview.workspaceId, prKey: 'example/app#21', kind: 'disable_mwr' });
    assert.equal((await call('follow.confirm-pr-action', { planId: plan.id, scope: 'target' })).state, 'submitted');
    w = await refresh(); assert.equal(byNumber(21).snapshot.mergeWhenReady, 'off');

    // ── Merge #21.
    plan = await call('follow.prepare-pr-action', { workspaceId: preview.workspaceId, prKey: 'example/app#21', kind: 'merge' });
    assert.deepEqual(plan.prs[0].blockers, []); assert.equal(plan.via, 'github'); assert.equal(plan.method, 'squash');
    const merged = await call('follow.confirm-pr-action', { planId: plan.id, scope: 'target' });
    assert.equal(merged.state, 'submitted', merged.result);
    w = await refresh(); assert.equal(byNumber(21).snapshot.state, 'MERGED');

    // ── The stack: merging #23 merges #22 first, retargets #23 to main, then merges #23.
    plan = await call('follow.prepare-pr-action', { workspaceId: preview.workspaceId, prKey: 'example/app#23', kind: 'merge' });
    assert.deepEqual(plan.prs.map(p => p.number), [22, 23]);
    assert.ok(plan.prs.every(p => !p.blockers.length), JSON.stringify(plan.prs));
    const stack = await call('follow.confirm-pr-action', { planId: plan.id, scope: 'downstack' });
    assert.equal(stack.state, 'submitted', stack.result);
    w = await refresh(); assert.equal(byNumber(22).snapshot.state, 'MERGED'); assert.equal(byNumber(23).snapshot.state, 'MERGED');
    assert.deepEqual(await logged(), [
      'pr merge 21 --auto --squash --match-head-commit head-21',
      'pr merge 21 --disable-auto',
      'pr merge 21 --squash --match-head-commit head-21',
      'pr merge 22 --squash --match-head-commit head-22',
      'pr edit 23 --base main',
      'pr merge 23 --squash --match-head-commit head-23',
    ]);
    await page.setViewportSize({ width: 1440, height: 1000 }); await open();
    await capture('panel-merged', false);

    // ── The same repository forced to Graphite: the Graphite surfaces come back, as on main.
    await mutate(d => { d.prs[24] = pr(24, 'Graphite-mode comparison PR', 'graphite-pr', 'main', { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }); });
    await call('follow.register-pr', { agentId: preview.agentId, repo: 'example/app', number: 24, stack: 'Graphite check', parentNumber: null });
    const forced = await call('follow.set-pr-workflow', { repo: 'example/app', setting: 'graphite' });
    assert.equal(forced.repos.find(r => r.repo === 'example/app').effective, 'graphite');
    // A poll already running when the setting changed still used the old workflow; the next one applies it.
    w = await refresh(); if (byNumber(24).snapshot.prWorkflow !== 'graphite') w = await refresh();
    assert.equal(byNumber(24).snapshot.prWorkflow, 'graphite');
    plan = await call('follow.prepare-pr-action', { workspaceId: preview.workspaceId, prKey: 'example/app#24', kind: 'merge' });
    assert.ok(plan.prs[0].blockers.some(b => /Graphite/.test(b)), 'Graphite readiness gates merge again');
    await open();
    await page.getByRole('button', { name: new RegExp('^Pull request 24: ') }).first().click();
    await page.getByText('Open in Graphite').first().waitFor();
    await capture('pr-sheet-graphite', false);
    await call('follow.set-pr-workflow', { repo: 'example/app', setting: null });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
  console.log(`PASS: auto→GitHub without sign-in; GitHub blockers; panel/sheet/confirm screenshots in ${shots}; auto-merge on/off; merge; 2-PR base-chain stack merged in order with retarget; Graphite mode restored on override.`);
} finally { await client.close().catch(() => undefined); }
