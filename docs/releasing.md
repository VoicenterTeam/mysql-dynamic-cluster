# Releasing

How a release of `@voicenter-team/mysql-dynamic-cluster` is cut. The package
goes to the internal registry. `package.json` has no `publishConfig` on
purpose (issue #51), so nothing in the repo decides where a publish goes:
the command line and the npm config of the publisher do.

## 1. Bump the version

Change the version in `package.json` and `package-lock.json` in a small PR
of its own. `npm version <new version> --no-git-tag-version` changes both
files and makes no commit and no tag. Merge that PR before publishing.

## 2. Check the npm config

```
npm config get @voicenter-team:registry
```

A registry set for the `@voicenter-team` scope in an npm config wins over
the `--registry` flag. If this prints a URL, the publish goes there,
whatever the flag says. Make sure it is the registry you mean, or change
the setting first.

## 3. Dry run

Always run the dry run first, with the same flags as the real publish:

```
npm publish --dry-run --registry <url of the internal registry> --tag <tag>
```

Read the `Publishing to` line of the output. It names the registry and the
tag. Stop if either is not what you expect. The file list above it should
hold `dist/`, `assets/`, `package.json`, `README.md` and `LICENSE`, and
nothing else from the repo.

`npm run build` runs by itself on `prepublishOnly`, for the dry run and for
the real publish. Two things it does not do:

- It does not empty `dist/` first. A file left there by another branch
  stays and is packed. Delete `dist/` before the dry run when the checkout
  was on another branch.
- It does not run with `--ignore-scripts` or `ignore-scripts=true` in an npm
  config. Then the tarball holds whatever `dist/` held before.

## 4. Publish

```
npm publish --registry <url of the internal registry> --tag <tag>
```

Pass `--registry` and `--tag` on the command every time. Do not rely on a
default.

## Which tag

- `--tag rc` for a release candidate, such as `4.0.1-rc.1`, of a line whose
  stable version is on `next`. `npm i @next` keeps giving the stable version,
  and a consumer tests the candidate by its exact version: a range such as
  `^4.0.0` never installs a pre-release.
- `--tag next` for a version that should not become what a plain
  `npm install` gives: a release of a line the owner has not made the default
  yet, or a pre-release of a line that has no stable version on `next`.
- `--tag latest` only for the newest version of the line the owner made the
  default. A fix release on an older line must not get it: with an explicit
  `--tag latest`, npm 11 no longer refuses a version lower than the highest
  published one, and `latest` would move back.

Moving `latest` is the owner's decision each time.

Without `--tag`, npm uses `latest`. npm 11 refuses a pre-release version
without `--tag`.
