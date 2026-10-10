# Releasing

## The first release, by hand

npm only lets a workflow publish a package that already exists, so the first version goes out from
your machine.

1. Create an account on [npmjs.com](https://www.npmjs.com/signup) and turn on two-factor
   authentication (required for publishing).
2. Publish:

   ```sh
   git clone https://github.com/saykachi/tomiko && cd tomiko
   npm ci
   npm login
   npm publish --dry-run   # shows exactly what goes into the package
   npm publish             # runs the typecheck, tests, build and smoke test first
   ```

3. Let GitHub publish from now on: on npmjs.com open the package → **Settings** →
   **Trusted Publisher** → **GitHub Actions**, and enter owner `saykachi`, repository `tomiko`,
   workflow `release.yml`. No token is needed.
4. Tag the release on GitHub so the changelog links work: **Releases** → **Draft a new release** →
   tag `v0.1.0` → publish. The release workflow sees 0.1.0 is already on npm and skips publishing.

## Every release after

1. In `CHANGELOG.md`, move the entries under **Unreleased** to a new version heading with today's
   date.
2. Bump the version. This edits `package.json`, commits and creates the tag `vX.Y.Z`:

   ```sh
   npm version patch   # fixes      0.1.0 → 0.1.1
   npm version minor   # features   0.1.0 → 0.2.0
   npm version major   # breaking   0.1.0 → 1.0.0
   git push --follow-tags
   ```

3. On GitHub: **Releases** → **Draft a new release** → choose the tag → paste the changelog section
   → **Publish release**. The **Release** workflow checks that the tag matches `package.json`, runs
   every check, and publishes to npm.

Versions with a suffix, such as `0.3.0-beta.1`, are published under the `next` dist-tag, so
`npm install tomiko` keeps getting the latest stable version.

While the repository is public, npm attaches a provenance statement to every version published by
the workflow, shown on the package page as "Built and signed on GitHub Actions". The README images
on the npm page are also loaded from the repository, so they only show up there once it is public.
