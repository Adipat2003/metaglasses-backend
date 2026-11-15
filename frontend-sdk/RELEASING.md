# Releasing

The package is built and checked in CI. Publish a GitHub release from the commit that contains
the matching package version and use `v<version>` as its tag. The publish workflow regenerates
the endpoint types, runs the SDK checks, verifies the package contents, checks the release tag
against `package.json`, then publishes with npm provenance.

The first publish must bootstrap the npm package because npm only allows trusted publishing to be
configured for a package that already exists. From the merged repository checkout, run:

```bash
npm login --auth-type=web
npm ci --prefix frontend-sdk
npm run generate --prefix frontend-sdk
npm test --prefix frontend-sdk
node scripts/check-frontend-sdk-package.mjs
cd frontend-sdk
npm publish --access public
```

Then, in the npm package settings, add a GitHub Actions trusted publisher with:

- GitHub owner: `Adipat2003`
- Repository: `metaglasses-backend`
- Workflow filename: `publish-frontend-sdk.yml`
- Allowed action: direct `npm publish`

After that setup, all later publishes use short-lived GitHub OIDC credentials. No npm token is
stored in GitHub. Publish future versions by updating `package.json` and `package-lock.json`, then
creating a release with a matching `v<version>` tag.
