# Releasing

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
2. `npm run release:notes <version>` (`scripts/release-notes.mjs`) moves every fragment under
   `## <version> (<date>)` at the top of `CHANGELOG.md` and deletes the fragments. Pass `-- --allow-empty` for a
   release with nothing user-facing. **Betas get no section:** for a version with a prerelease part, release:notes
   leaves the fragments in `changes/` for the next stable release. `check:notes` fails only when a stable
   `package.json` version has no `CHANGELOG.md` section. Never edit a released section, except to fix wording.
3. In the same commit, bump the version in `package.json` and `package-lock.json` together, commit
   `chore: release paseo-follow-up vX.Y.Z`, and push an immutable `vX.Y.Z` tag. Never move a published tag.
4. `.github/workflows/publish-npm.yml` runs on the tag. It checks:
   - the tag is on `main` and matches `package.json`;
   - trusted publishing (OIDC) authorization;
   - then runs `npm run verify` and `npm run test:install` with pinned Paseo 0.14 and the Claude and Codex CLIs,
     and `npm pack --dry-run`.

   Then it publishes:
   - A version with a prerelease part (`1.4.0-beta.24`) goes to the `beta` dist-tag and must never be `latest`.
   - A stable version goes to `latest`.
   - A GitHub release follows: a prerelease for betas.
5. Wait for registry integrity verification before saying the version is on npm. To retry a failed publish, run the
   workflow with `workflow_dispatch` and the existing tag. If a fix is needed, ship it as the next version rather
   than moving the tag.

## Installing on a host

Users run `paseo plugin install paseo-follow-up`, which installs the `latest` dist-tag. On the developer's own daemon, the
orchestrator installs or switches versions. Feature agents never touch the live install.
