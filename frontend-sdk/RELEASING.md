# Releasing

Successful push CI on `main` triggers the SDK publish workflow. The job requires the validated
commit to match the SHA in GitHub's provenance. It regenerates the endpoint types, runs the SDK
checks, and verifies the final package contents before publishing with GitHub OIDC and provenance. It runs on Ubuntu
24.04 with Node.js 22.16.0 and npm 11.5.1.

The checked-in `package.json` version supplies the major and minor version. The workflow uses the
CI run number as the patch version, creating a unique stable version such as `0.1.123`, and
publishes it to npm's `latest` dist-tag only if it is newer than the registry's current
`latest`. Publishes run one at a time so a rerun cannot roll the tag back. Frontends using
`npm install metaglasses-sdk` receive the newest publish. Pinned frontend dependencies update only when the frontend chooses to install or
upgrade the SDK.

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

After that setup, publishes use short-lived GitHub OIDC credentials. No npm token is stored in
GitHub. npm requires the first successful trusted publish within two days of configuring the
publisher. Update the major or minor version in `package.json` when intentionally changing the
SDK's compatibility line. The next qualifying `main` run publishes on that version line.
