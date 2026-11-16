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
hold `dist/` and `assets/` and nothing else from the repo.

`npm run build` runs by itself on `prepublishOnly`, for the dry run and for
the real publish, so the tarball is always built from the checked-out
source.

## 4. Publish

```
npm publish --registry <url of the internal registry> --tag <tag>
```

Pass `--registry` and `--tag` on the command every time. Do not rely on a
default.

## Which tag

- A release version, such as `4.3.0`: `--tag latest`.
- A pre-release version, such as `5.0.0-rc.1`: `--tag next`, so that
  `latest` does not move and a plain `npm install` keeps the last release.

Without `--tag`, npm puts every publish under `latest`, a pre-release too.
