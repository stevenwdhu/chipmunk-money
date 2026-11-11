# Releasing

A release is a version of Spending Tracker that people run: a Git tag, a GitHub release with its notes, and Docker images. Commits to `main` aren't releases. CI runs the checks on them, but builds and publishes no image. A release is made when the maintainer decides it's time, not on every push.

## Version numbers

Versions follow [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`, written with a v, like v0.4.2, or as "version 0.4.2" in a sentence. That's how they appear in the changelog, release titles, commit messages and the app. Two places leave the v out, as they're meant to: `package.json`'s `version`, and the Docker image tags (`:0.4.2`). The first release, v0.1.0, is the first Docker image (commit `beed743`, tagged afterwards). The root `package.json` holds the latest release's version until the next release sets its own. Each release goes up from the one before by what the commits since then hold, the biggest change deciding:

| Since the last release | The new version | Example |
|---|---|---|
| A breaking change: data or settings that need you to do something, or an API endpoint, field or MCP tool removed or changed in a way scripts notice | **Major** goes up, minor and patch go to 0 | v1.4.2 → v2.0.0 |
| A new feature, with or without fixes | **Minor** goes up, patch goes to 0 | v0.4.2 → v0.5.0 |
| Only fixes (and docs, tests, chores) | **Patch** goes up by one | v0.4.2 → v0.4.3 |

- A release goes up by one step, however many commits it has. Three fixes since v0.4.2 make v0.4.3, and the changelog lists all three.
- Before v1.0.0, a breaking change goes up the minor number instead of the major (v0.4.2 → v0.5.0), as Semantic Versioning allows while a project settles. v1.0.0 is for when the data, the API and the MCP tools are stable enough to promise that.
- Commit messages say which kind each change is, as [conventional commits](https://www.conventionalcommits.org): `feat:` is a feature, `fix:` a fix, and `feat!:` or a `BREAKING CHANGE:` line in the message is a breaking change. `docs:`, `test:`, `chore:`, `ci:` and `refactor:` don't change the version on their own.
- A database migration isn't breaking by itself: the app runs it on start, after saving a backup. It's breaking when it can't be undone by going back a version, or needs you to do something.

## Docker images

Each release is published as `ghcr.io/stevenwdhu/spending-tracker` with three tags, for amd64 and arm64:

| Tag | Moves to | Use it to |
|---|---|---|
| `:0.4.2` | Never: it's that release | Pin an exact version |
| `:0.4` | Each patch release of v0.4 | Get fixes, but no new features, on `docker compose pull` |
| `:latest` | Each release | Always run the newest release |

## Making a release

1. **Pick the version** from the commits since the last tag (`git log v0.4.2..HEAD --oneline`), by the rules above.
2. **Write the changelog.** In [CHANGELOG.md](../CHANGELOG.md), turn *Unreleased* into the version and the date (`## v0.5.0 (2026-12-01)`), with what changed under *Added*, *Changed*, *Fixed* and *Removed*, in words for the person using the app. Breaking changes go first, with what to do.
3. **Set the version** in the root `package.json`, without the v (`"version": "0.5.0"`).
4. **Commit and tag** on `main`: `chore(release): v0.5.0`, then `git tag v0.5.0`.
5. **Push both:** `git push origin main v0.5.0`. CI runs the checks on the tag, then builds and publishes the image. (The push to `main` starts a run too, but it skips a `chore(release):` commit, which the tag's run already checks.) Its publish job stops if the tag isn't `package.json`'s version.
6. **Publish the notes:** `gh release create v0.5.0 --title v0.5.0 --notes-file <that version's changelog section>`.
7. **Check** that the images are on the registry under the three tags, and that `docker compose pull && docker compose up -d` runs it.
