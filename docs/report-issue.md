# Report an issue

A developer asks an agent to "report an issue about Follow-up" (a bug, a feature request or feedback), and the agent
files a detailed issue in [tomgrin10/paseo-follow-up](https://github.com/tomgrin10/paseo-follow-up) through the
developer's own GitHub sign-in. The agent interviews them, inspects or reproduces the problem, dry-runs, shows the
exact issue, and files only after an explicit yes. A **Report a bug** button finds the same path for people looking
for one: it doesn't file anything itself, it hands the developer's words to an agent.

## The shared module: `server/report-issue/`

Plugin-agnostic, so the developer's other plugins can drop it in with a small adapter and their own tool prefix.
Nothing in the folder imports Follow-up; `tests/report-issue.test.ts` fails on an import from outside it (only `./`,
`node:` and `zod`). One injected `ReportPluginConfig`: name, repo, tool name, assets folder, the reporter's GitHub,
`diagnostics()` and `redaction()`.

| File | What it does |
| --- | --- |
| `server/report-issue/index.ts` | `Reporter`: the three calls (procedure, dry run, confirm), plans (20 minutes, per agent), the no-auth fallback, `manualIssueLink` for the sheet's Open on GitHub, the tool's description and schema. |
| `server/report-issue/redact.ts` | `Redactor`: tokens, emails, IPs, the hostname, the home directory, private repository names and owners, private PR titles. `looksSecret`, the last check before anything leaves. |
| `server/report-issue/render.ts` | Required and recommended fields per kind, the body template, the diagnostics `<details>` block, labels, the prefilled new-issue URL (cut to 7,500 chars), the folder slug. |
| `server/report-issue/github.ts` | Who the reporter is, which repositories are public (cached 6 h), likely duplicates (search, open and closed), create issue, add comment, and screenshot upload to `<login>/paseo-issue-assets`. |
| `server/report-issue/diagnostics.ts` | The shared environment section (OS, arch, kernel, distribution, Node, gh and whether it's signed in, provider CLIs) and `LogRing`, the worker's recent `[follow-up]` warnings and errors, in memory. |

### The tool: `report_issue` (`mcp__paseo__follow_report_issue`)

Context cost (invariant `report-issue-costs-no-standing-context`): the description is one line of at most 150 chars
(`MAX_DESCRIPTION`, `reportToolDescription`). The procedure, the template, the redaction notes and the screenshot
consent steps come back in the first call's reply, so they cost context only while someone is reporting. Nothing
is added to the SessionStart hook, tool instructions or MCP resources. The tool is served to root agents and to
contributors (it changes nothing in Follow-up), never to recovery sessions.

1. `{ kind, summary }` → `stage: "procedure"`: the eight steps, the required and recommended fields for the kind with
   what each means, and the optional ones.
2. `{ kind, title, …fields }` → `stage: "missing"` with the list (nothing planned), or `stage: "dry_run"`: the exact
   title, labels and body, likely duplicates, what was redacted, screenshot consent (which files, where), a `planId`.
   Reads only (invariant `report-issue-files-only-after-confirm`).
3. `{ confirm: true, planId, screenshot_consent }` → files it, or comments on `comment_on`, and returns the link. A
   plan with screenshots refuses a confirm without `screenshot_consent` (true or false), so the choice is explicit
   for every report. Without GitHub auth (no token, or a 401), it returns a prefilled `issues/new` link and the full
   markdown to paste instead, and posts nothing.

Required fields: a bug needs title, what happened, steps, expected and actual; a feature request title, problem and
proposal; feedback a title and the feedback. Labels: `bug`, `enhancement` or `feedback`, plus `via-agent` (created
in the repository; GitHub drops labels a reporter without push access sends, so triage may add them).

### Redaction (invariant `report-issue-never-carries-secrets`)

Every field the agent wrote, every diagnostics row and every log line passes one `Redactor` per report:

- tokens (`ghp_`, `gho_`, `github_pat_`, `sk-`, `xox*`, AWS keys, JWTs, bearer headers, `password=`-style pairs,
  credentials in URLs, private key blocks) → `<token>`;
- emails → `<email>`, IP addresses → `<ip>` (not 127.0.0.1), the machine's hostname → `<host>`;
- the home directory and any `/home/<user>` or `/Users/<user>` → `~`;
- private repositories → `repo-N` (full name and bare name), an owner with no public repository → `org-N`, private
  PR titles and workspace titles → `PR-N`. N is stable within a report.

Public repositories keep their names (checked on GitHub; unknown counts as private), and the developer can allow a
name through (`allow_names`). The dry run says what was replaced. If anything still looks like a secret after
redaction, the dry run refuses. Guarded by `tests/report-issue-redact.test.ts` and `tests/report-issue.test.ts`.

### Diagnostics

Collected only while a report is prepared, never in the background, inside a collapsed `<details>`:

- **Versions and install:** Follow-up's version, channel, install source and update mode, the last update, Paseo's
  daemon version (from server_info), the Paseo CLI.
- **Environment:** OS, arch, kernel, distribution, Node, gh (version, signed in and to how many accounts, never a
  token), Claude Code, Codex, Graphite.
- **Follow-up state** (bugs only): tracked workspaces and Auto-send count, open PRs and repositories, blocked
  batches, PRs that failed to refresh, Following and inbox settings, the update phase, worker uptime, RSS and the
  governor's level, whether tools are native or the bridge, and the last 20 `[follow-up]` warnings and errors.

A feature request carries versions and environment; feedback carries versions only.

### Screenshots

With the developer's yes for that report (`screenshot_consent: true`), the files go to a public repository in the
reporter's account, `<login>/paseo-issue-assets`, created with a short README when missing, under
`follow-up/<date>-<title-slug>/1.png` (contents API; the same report sent again replaces its files in place) and are
embedded with `raw.githubusercontent.com` URLs. The dry run names each file and where it goes and tells the agent to
ask the developer to check the images for private information, since images can't be redacted like text; the
procedure has the agent look at each image and point out anything that looks private first. On no, no auth, a
private assets repository or an upload failure, the issue is filed text-only and the reply tells the agent to give
the link and ask the developer to drag the images in. The body describes every screenshot in words either way.

## Follow-up's adapter: `server/report-issue-adapter.ts`

`followUpReporter` builds the config (repo `tomgrin10/paseo-follow-up`, tool `follow_report_issue`, folder
`follow-up`), the diagnostics above from `follow.updates`, `follow.follow-settings`, `settings.display`, the store,
the governor and the log ring, and the redaction lists (every repository, PR title, workspace title and goal it
knows). `reportPrompt` writes what the sheet sends. The worker (`index.server.ts`) installs the log ring at start and
restores the console at stop.

RPCs, for the sheet:

- `follow.report-issue-targets`: who the sheet can send to. Directory metadata only, so nothing is loaded: the agent
  in focus, then this workspace's agents (main first), then other main agents, at most 12; and the workspace a new
  agent would start in.
- `follow.report-issue-send`: sends the report prompt to the chosen agent, or starts a new one in that workspace with
  the prompt (the Overseer role's provider, the default model).
- `follow.report-issue-link`: the prefilled new-issue link with the redacted versions block, for Open on GitHub.

Parity: `follow.report-issue-send` and `follow.report-issue-targets` map to `report_issue` (an agent reports
directly; it doesn't need to hand a prompt to itself), `follow.report-issue-link` is the tool's own no-auth fallback.

## The UI: `client/report-issue.tsx`

- **Settings → General → Help:** a **Report a bug** row ("Or an idea, or feedback…") with Report.
- **Command Center:** "Follow-up: Report a bug, idea or feedback" (keywords bug, issue, feature request, feedback,
  GitHub).
- **`/report-issue`** in an agent's composer: with words, they go straight to that agent; without, the sheet opens
  with that agent picked.
- **Error toasts:** every Follow-up error toast gets **Report this**, which opens the sheet with the error attached.
- **The sheet** (`ReportSheet`, a Paseo Modal: a dialog on desktop, a bottom sheet on phones): Bug / Idea / Feedback,
  one text box, **Send to** (the default agent, others, or A new agent), the trust line, then Send to agent. Sent shows
  who got it with Open the chat. With nowhere to send it (no workspace at all), Open on GitHub opens the prefilled
  issue instead. `openReportSheet()` opens it from anywhere; a host is mounted on Home, the panel and Settings.

The repository has issue forms for people filing by hand: `.github/ISSUE_TEMPLATE/bug_report.yml`,
`feature_request.yml` and `config.yml`.
