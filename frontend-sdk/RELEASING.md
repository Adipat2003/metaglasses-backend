# Releasing

The package is built and checked in CI. Publish a GitHub release from the commit that contains
the matching package version and use `v<version>` as its tag. The publish workflow regenerates
the endpoint types, runs the SDK checks, verifies the package contents, checks the release tag
against `package.json`, then publishes with npm provenance. It runs on Ubuntu 24.04, uses Node.js
22.16.0 and npm 11.5.1, and receives short-lived publish credentials from GitHub OIDC.

The initial public package, `metaglasses-sdk@0.1.0`, is published. The one-time bootstrap is
included below for recovery or a future package rename. npm requires the package to exist before
trusted publishing can be configured. Run this from a merged repository checkout with an npm
account that can publish the package:

```bash
npm login --auth-type=web
npm ci --prefix frontend-sdk
npm run generate --prefix frontend-sdk
npm test --prefix frontend-sdk
node scripts/check-frontend-sdk-package.mjs
cd frontend-sdk
npm publish --access public
```

The npm account must have two-factor authentication enabled for the interactive bootstrap publish.
Complete npm's 2FA challenge, such as its security-key prompt. Do not put an npm token in this
repository or GitHub Actions.

Then, in the npm package settings, add a GitHub Actions trusted publisher with:

- GitHub owner: `Adipat2003`
- Repository: `metaglasses-backend`
- Workflow filename: `publish-frontend-sdk.yml`
- Environment name: leave blank
- Allowed action: direct `npm publish`

After that setup, all later publishes use short-lived GitHub OIDC credentials. No npm token is
stored in GitHub. npm requires the first successful trusted publish within two days of configuring
the publisher. Publish future versions by updating `package.json` and `package-lock.json`, then
creating a release with a matching `v<version>` tag.
