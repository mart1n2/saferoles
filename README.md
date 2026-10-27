# SafeRoles

Local-first RBAC policy management for Safe and Zodiac Roles. A React + Vite
static application: no application server, database, login, or same-origin API
routes. Deploy `dist/` to Cloudflare Pages, Vercel, or an HTTPS static host.

## Run

Node.js 24 or later is required by Zodiac core. Versions are pinned exactly.
TypeScript remains at 6.0.3 for ESLint parser compatibility.

```sh
npm ci
npm run dev
npm test
npm run build
npm run preview
```

## What it does

Choose a network and Safe to discover Roles configurations, or open a modifier
address directly. Inspect roles, members, function/parameter permissions and
allowances. Draft changes are planned locally with calldata shown for review.
SDK v4 constructs conditions; the local LGPL compatibility planner retains the
full-state diff/encoder behavior. See [source notice](app/lib/zodiac-compat/NOTICE.md).

Inside Safe, initialize RBAC in an atomic batch: deploy the pinned Roles 2.1.1
minimal proxy, enable it as a module, and configure the first role. The app
verifies proxy code and Safe control relationships, then waits for indexed state
before opening the editor. Deployed role keys cannot be renamed accidentally.
No new smart contracts are developed or deployed by the website itself without
an explicit wallet/Safe approval.

Browser wallets are discovered by EIP-6963 through wagmi and use viem for RPC.
Choose a provider explicitly, switch wallets or disconnect. Account, connector
and network changes invalidate earlier checks. WalletConnect is not included.
An owner EOA is not the Safe: ordinary EOAs can connect, but configuration must
be approved in Safe or sent from a verified Safe-aware wallet account. Atomic
initialization cannot fall back to sequential transactions; partial sequential
policy submissions preserve their already-broadcast transaction hashes.

## Data sources

- **Roles discovery and snapshots:** browser requests the public Zodiac indexer
  directly. Full role/member/target/condition enumeration is indexer-backed,
  not an assertion that every field was independently proven at a block.
- **Control checks and initialization verification:** selected wallet or Safe
  host RPC. Unknown verification results block submission.
- **ABIs:** Sourcify, optionally Etherscan with a user key, or manual entry.
  Public service CORS/rate limits may prevent automatic lookup; paste an ABI.
- **Safe transactions:** host SDK within the matching Safe, or direct Safe
  Transaction Service requests with the user's unlocked API key. Status reads
  show signatures, execution state and hash when available. CORS/service failures
  remain unknown, not successful or cancelled. Status does not unlock a stale
  policy baseline. Pending signatures are offchain and cannot be inferred from
  a normal transaction receipt or safeTxHash alone.

No private API key is bundled in the build. External services receive the
addresses/requests needed for their lookup. RPC and API providers remain
availability dependencies even though the app has no backend.

## Local work and backups

Drafts, per-browser submission history, ABI overrides/cache, and encrypted API
keys live in IndexedDB for this origin. Draft saves compare versions in a single
transaction to prevent silent overwrites across tabs. Drafts are scoped to
`(chainId, rolesMod)` and retain the indexed baseline fingerprint.

The Drafts dialog exports the current edits as JSON even if local storage is
unavailable. Import validates scope, permissions, version and size, and creates a
new draft. It never includes API keys. There is no cross-device sync or shared
organization workspace. Labels/unsent drafts cannot be recovered from chain.
Browser cleanup, origin changes and Safe iframe storage partitioning can make
local records unavailable: export work you need to retain. Existing hosted D1
data is not imported or deleted by this migration.

### Form autosave

Unfinished forms are also autosaved to the `forms` IndexedDB store (database
version 2) so a reload or accidental close does not lose them:

- the policy editor's working diff, keyed by `(chainId, rolesMod)`, with the
  indexed baseline hash it was made against;
- the first-role initialization form, keyed by `(chainId, safe)`;
- the chain/address inputs on the Safe picker and the advanced modifier entry.

Restored policy and setup forms show a recovery banner with **Discard** and
**Keep editing**. A restored policy is re-diffed against the freshly indexed
state, flagged if that state changed since, and goes through the normal review
and verification. Records are versioned, size-bounded (2 MB), scope-checked and
validated on read; corrupt or mismatched ones are deleted. Reverting, discarding
or completing a flow clears its record. API keys are never autosaved. If storage
is unavailable, editing continues without recovery.

## User API keys

Open **API keys** from the Safe picker or editor. Safe Infrastructure and
Etherscan keys are optional:

- **Use in memory** keeps the key only in this loaded page session. Previously
  saved encrypted data, if any, is unchanged.
- **Encrypt and save** derives a non-extractable AES-256-GCM key with Web Crypto
  PBKDF2-SHA256 (600,000 iterations, fresh 16-byte salt and 12-byte IV). The
  service identity is authenticated with the ciphertext.
- Only the versioned ciphertext envelope is written to IndexedDB. Neither the
  passphrase nor the derived key is saved. Reload requires explicit unlock.
- **Lock all keys** clears session keys; **Delete saved key** removes that
  service's ciphertext and current session key. Replacing it requires entering
  the new key. Passphrases cannot be recovered.

Encryption protects saved data, not keys while unlocked in page memory. Use
only service API keys, never wallet private keys or seed phrases. Credentials go
directly to the fixed service endpoint, without an application proxy. Browser
CORS/provider access restrictions still apply. Etherscan's API places its key in
its HTTPS query string; the app uses no-referrer and does not log the URL.

## Deploy

Build command: `npm ci && npm run build`; publish directory: `dist`.

- **Cloudflare Pages:** connect the repository, use the build command and output
  directory above. `public/_headers` is copied into `dist` for manifest CORS,
  frame policy, no-referrer and asset caching. No Worker or D1 binding is needed.
- **Vercel:** the checked-in `vercel.json` configures the same static output and
  response headers. No functions or database integration is needed.
- **AWS:** use Amplify static hosting, or a private S3 REST origin + CloudFront
  with origin access control. Configure equivalent response headers manually;
  S3/CloudFront do not interpret `_headers` or `vercel.json`. Use HTTPS. No EC2,
  containers, RDS or exposed S3 website bucket is required.

`manifest.json` must be publicly fetchable with `Access-Control-Allow-Origin: *`.
Do not apply `X-Frame-Options: DENY/SAMEORIGIN` to the app; CSP permits Safe
embedding. Keep HTML short-cached and hashed assets immutable. Keep previous
release assets long enough for already-open tabs to load lazy chunks. Use a
stable domain: browser-local storage is origin-bound.

CI validates types, lint, unit tests, production build and static artifacts.
Before publishing, verify actual host headers, Safe iframe behavior, browser
CORS, and the supported wallet flows. Automated wallet/Safe tests use stubs;
no transaction is signed or broadcast by the test suite. This change does not
publish or migrate production data.

See [architecture](docs/architecture.md) and [deployment assessment](docs/deployment-options.md).
