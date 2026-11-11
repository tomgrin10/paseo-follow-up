# Release note fragments

Every PR that changes something a user can see or feel adds one file here, named after its branch
(`changes/feat-auto-update.md`). The file holds one to three `- ` bullets:

```
- Follow-up can update itself. Choose how in Settings → Updates.
```

Write for the person using Follow-up: what changed for them, in plain words. Short. No PR numbers,
file names or internal terms, no emoji, no em dashes. Pure refactors, tests and CI changes need no file.

At a stable release, `npm run release:notes <version>` moves every fragment under a `## <version> (<date>)`
heading at the top of CHANGELOG.md and deletes the fragments. Betas get no notes: the fragments stay here, and the next
stable release (2.0) collects them all. A major's release candidate (`2.0.0-rc.0`) writes that major's section
(`## 2.0.0`), and later rcs and the final release reuse it. `npm run check:notes` (part of
`npm run verify`) rejects fragments and changelog entries that break these rules.
