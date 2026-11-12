# Releasing

**Permission.** A release needs Tom's manual permission, every time; no agent releases on its own. Features and fixes
ship to a beta by default. An rc, a stable version, npm `latest` or a hotfix needs his explicit OK for that exact
version first (a hotfix skips the beta, not the permission). Quote his OK in the release commit body.

## In a feature PR

- **Release-note fragment.** If users can see or feel the change, add `changes/<branch>.md` with one to three `- ` bullets. Write them for the person using Follow-up, in plain words,
  with no PR numbers, file names or em dashes. The rules are in `changes/README.md`, and `npm run check:notes` (part
  of `verify`) enforces them. Pure refactors, tests and CI changes need no fragment.
- **No version bump.** Don't bump `package.json` or tag in a feature PR.
- **Rebase onto main** before opening, and keep the diff focused.

## Cutting a release (the orchestrator's job)

The orchestrator is Tom, or the coordinating agent he runs releases from. Feature agents report their PR to it and
stop.

1. Start from a clean `main` that has every PR to ship.
2. **Notes come in two tiers.**
   - **A beta** gets no CHANGELOG section. Its fragments stay in `changes/` for the next stable or rc, and its GitHub
     release shows them as they are.
   - **A stable version or a major's rc is curated.** `npm run release:notes <version>` (`scripts/release-notes.mjs`)
     writes a DRAFT section: the fragments as starting material under a `<!-- DRAFT … -->` line, then a generated
     "Full changelog since <last stable>" in a collapsed `<details>` block (every fragment, deduplicated and grouped by
     area), and deletes the fragments. Rewrite the draft into a short section grouped by what a user gets, lead with
     what matters, cut internal fixes, and delete the DRAFT line. `check:notes` (in `verify`, so in the publish
     workflow too) fails while the line is there. A curated section can use `###` headings, paragraphs, images and
     a `---` rule; What's new shows them as written, the first paragraph as the intro and what follows the rule (the
     credits) as a quiet footnote. An image is a line of its own, `![alt](url#WxH)`: the alt text is what a screen
     reader says, `#WxH` is its shape (so the sheet reserves it before it loads), and the URL is
     raw.githubusercontent.com at a full commit hash, never `main`, so re-shooting a screenshot never changes notes
     already shipped. Commit the image first, pin to that commit, and merge with a merge commit (not squash or rebase),
     so the commit stays in `main`'s history; `tests/changelog.test.ts` fails otherwise. Pass `-- --allow-empty` for a release with nothing user-facing.
   - **A major's rc** (`2.0.0-rc.N`) carries the major's own section (`## 2.0.0`). A later rc or the final `2.0.0`
     keeps the curated text as written and adds its new fragments to the full list. In the app, `notesVersion`
     (`shared/changelog.ts`) maps an rc to that section, so 1.x → rc.0 shows What's new once, and rc.N → 2.0.0
     doesn't show it again. The parser stops at `<details>`, so the full list never reaches What's new.
   - `check:notes` also fails when a stable version or a major's rc has no section of its own. Never edit a released
     section, except to fix wording.
3. In the same commit, bump the version in `package.json` and `package-lock.json` together, commit
   `chore: release paseo-follow-up vX.Y.Z`, and push an immutable `vX.Y.Z` tag. Never move a published tag.
4. `.github/workflows/publish-npm.yml` runs on the tag. It checks:
   - the tag is on `main` and matches `package.json`;
   - trusted publishing (OIDC) authorization;
   - then runs `npm run verify` and `npm run test:install` with pinned Paseo 0.15.2 and the Claude and Codex CLIs,
     and `npm pack --dry-run`.

   Then it publishes:
   - A version with a prerelease part (`1.4.0-beta.24`) goes to the `beta` dist-tag and must never be `latest`.
   - A stable version goes to `latest`.
   - A GitHub release follows (a prerelease for any version with a prerelease part). **Every release page has
     notes, in one format** from `scripts/release-body.mjs`: an install line on top, `## What's new`, then
     `## Install` and the verification sentence. The notes are the version's curated CHANGELOG.md section for a
     stable or a major's rc (the collapsed full changelog included), and for a beta the `changes/` fragments added
     since the previous tag, as written. A beta only renders its fragments; they stay in `changes/` for the next
     curated section. A beta with no fragments says "Maintenance release; no user-visible changes." The install
     command appears once, at the top; `## Install` holds the update command, the dist-tag note, the Paseo floor and,
     only when that run did those checks, the verification sentence. Preview a body
     with `node scripts/release-body.mjs <tag>`. This is the GitHub page only: What's new in the app stays
     major-only. `tests/release-body.test.ts` covers the format and that the workflow uses the renderer.
5. Wait for registry integrity verification before saying the version is on npm. To retry a failed publish, run the
   workflow with `workflow_dispatch` and the existing tag. If a fix is needed, ship it as the next version rather
   than moving the tag.

## Backfilling old release pages

`node scripts/backfill-release-notes.mjs` puts every existing GitHub release page in the same format and writes the
new bodies to a folder; it edits nothing. Read them, then run it again with `--apply` (`--only a,b` limits it,
`--except v2.0.0-rc.0` leaves a page alone) to `gh release edit` each one.

- Every page's current body is saved first (`<tag>.before.md` and `backup.json`), so any page can be restored.
- A stable or rc page with notes of its own was curated and is left exactly as it is (invariant
  `backfill-keeps-curated-notes`; rc.0's page tells 1.x users the old id to update).
- A beta page someone wrote keeps its text verbatim under `## What's new`. Only the old install and check boilerplate
  sentences go (the Paseo floor, the install id, install and update commands, the generic checks claim); the dry run
  lists each one. The page's own `## ` headings move one level down.
- A page with no notes gets the release's rendered notes: the betas up to 1.4.0-beta.29 use the per-beta sections
  CHANGELOG.md had at `v1.4.0-beta.68`, later betas their fragments. The 1.1 to 1.3 betas and any release with
  nothing at all say so in one line.
- A backfilled page installs the exact version, uses that release's plugin id, and keeps the verification sentence
  only when the tag's own publish workflow ran those checks, worded "before it was published to npm".
- Running it again changes nothing: a page already in the format is left alone.

## Installing on a host

Users run `paseo plugin install paseo-follow-up`, which installs the `latest` dist-tag. On the developer's own daemon, the
orchestrator installs or switches versions. Feature agents never touch the live install.
