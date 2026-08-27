# Changesets

Every user-visible change ships with a changeset: a short note saying what changed and how the
version should move. Release tooling turns those notes into `CHANGELOG.md` and the version bump, so
the changelog is written by whoever made the change rather than reconstructed from commits later.

Add one with:

```bash
npm run changeset
```

Pick `patch` for fixes, `minor` for new tools or options, `major` for anything that breaks an
existing setup — a renamed or removed tool, a changed argument, a new required environment
variable. Write the note for someone upgrading, not for someone reading the diff.

Changes with no effect on users — refactors, tests, CI, formatting — need no changeset.

Merging to `main` opens a pull request that applies the pending changesets: it bumps the version in
`package.json` and writes the entries into `CHANGELOG.md`. Nothing is published from CI; run
`npm publish` by hand if and when you want a release on npm.

Full documentation: https://github.com/changesets/changesets
