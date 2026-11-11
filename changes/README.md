# Release note fragments

Every PR that changes something a user can see or feel adds one file here, named after its branch
(`changes/feat-auto-update.md`). The file holds one to three `- ` bullets:

```
- Follow-up can update itself. Choose how in Settings → Updates.
```

Write for the person using Follow-up: what changed for them, in plain words. Short. No PR numbers,
file names or internal terms, no emoji, no em dashes. Pure refactors, tests and CI changes need no file.

A beta's GitHub release shows its own fragments; the fragments stay here. At a stable release or a major's release
candidate (`2.0.0-rc.0`), `npm run release:notes <version>` drafts that version's section in CHANGELOG.md from every
fragment, adds the full list of them in a collapsed `<details>` block, and deletes the fragments. The draft is then
curated by hand (see [docs/releasing.md](../docs/releasing.md)): What's new shows the curated part, never a list of
fragments. Later rcs and the final release keep the major's curated section and add to its full list. `npm run check:notes` (part of
`npm run verify`) rejects fragments and changelog entries that break these rules.
