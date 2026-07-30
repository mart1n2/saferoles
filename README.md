# SafeRoles

RBAC policy control for **Zodiac Roles**, with Safe-native approvals.

SafeRoles reads an indexed snapshot of a Roles modifier's on-chain
configuration, lets you edit it, and submits the exact difference from that
snapshot for Safe approval. The diff a reviewer reads and the calldata that gets
signed are the same object — there is no separate edit log that can drift from
what is actually proposed.

## How it works

1. **Read indexed state.** The modifier's policy (roles, members, targets,
   conditions, allowances) is read through the Zodiac Roles indexer, proxied by
   this app's Worker so it also works inside the Safe App iframe.
2. **Edit a draft** of that state.
3. **Plan continuously.** Every edit re-diffs the draft against the loaded
   snapshot and produces the exact Roles calls needed, via
   `zodiac-roles-sdk`.
4. **Submit.** The batch goes to the Safe for threshold approval.

### Fidelity guarantees

These are the properties that make the diff trustworthy, each covered by a test:

- **Importing a policy and changing nothing plans nothing.** Synthetic fixtures
  cover ordinary permissions as well as residual on-chain state the editor
  cannot reproduce: both plan zero calls when untouched.
- **Conditions the editor cannot represent are never rewritten.** Nested
  `and`/`or`, tuple matching and bitmasks are preserved byte-for-byte and shown
  read-only rather than approximated into something weaker.
- **Nothing is planned while any value is invalid.** An unencodable role is an
  *absent* role, and absence reads to the planner as "revoke everything in it".
  Issues therefore block the diff entirely instead of producing a
  plausible-looking mass revocation.
- **State the model cannot reproduce is replayed verbatim**, so editing one field
  never incidentally cleans up unrelated on-chain rows.
- **Encoded values are never scraped from display text.** A condition's value and
  its label are separate fields; renaming a label cannot change calldata.
- **Editing an allowance preserves spent balance and refill window.**
  `setAllowance` overwrites every field, so carrying these through is what stops
  an unrelated edit from silently refunding a budget.
- **Risk is derived from the planned call**, not from parameter names.

Encoding and diffing are delegated to `zodiac-roles-sdk`, which owns Roles v2
correctness (condition trees for tuples and arrays, comparison-value packing,
clearance transitions). Before anything is signed, the SDK's integrity check —
the same rule set as the modifier's `Integrity.sol` — runs locally, turning what
would be an on-chain revert *after* owners have signed into a blocking pre-flight
error.

### Trust and freshness

The policy snapshot comes from the Zodiac Roles indexer. SafeRoles validates and
round-trips that response, but it does not prove the indexer's block freshness or
anchor the snapshot to a block number. Immediately before submission it fetches
the policy again and compares fingerprints. A changed snapshot blocks submission
and requires a fresh review. This catches changes already visible to the indexer;
it does not remove indexer lag or establish chain finality. A saved draft's base
fingerprint provides the same kind of stale-draft warning when it is reopened.

ABIs from Sourcify, Etherscan, or manual input are authoring and display
metadata. SafeRoles verifies that an adopted signature hashes to the stored
selector, but a manual or stale ABI can still describe the wrong implementation
or misleading parameter names. The target address, selector, conditions, and
encoded calldata are what the modifier enforces.

## First-time setup

A Safe with no Roles modifier is offered one. The batch is two calls, both from
the Safe: deploy a modifier proxy through the Zodiac ModuleProxyFactory, then
`enableModule` on the address the deployment will create. `owner`, `avatar` and
`target` are all the Safe — the Safe governs the modifier, permissions act on the
Safe, and calls route through it.

**Enabling a module grants it authority to execute transactions from the Safe
without owner signatures.** That is what makes a Roles modifier useful — it
enforces the policy instead — but it means the contract being enabled must be the
right one. So nothing is taken on trust, and the batch cannot be submitted until
every check passes:

| Check | Why |
| --- | --- |
| Address is the approved mastercopy | Setup cannot substitute an arbitrary module implementation. |
| Contract exists on this chain | `eth_getCode` is non-empty. |
| Runtime bytecode matches | The deployed code hashes to the reviewed Roles runtime. |
| Source identifies as Roles | Published source names it `Roles` **and** declares the full Roles v2 interface. |
| Zodiac factory runtime matches | The factory exists and hashes to the reviewed runtime. |
| Target address is unoccupied | Deploying over an existing proxy reverts. |

The mastercopy is pinned to the reviewed Roles v2 deployment; it is displayed,
not editable. Supporting another implementation requires a reviewed code change
that updates both the approved address and expected runtime hash.

The derived proxy address is shown before submission, and it is the same address
the encoded `enableModule` call enables. Change the salt to derive a different
one.

Setup works from the Safe UI, and from an atomic-batch-capable Safe-aware wallet
with a positively identified Safe selected as the active account. Sequential
wallet fallback is blocked for setup so deployment and module enablement cannot
partially apply.

## Choosing what a role may call

Enter a target address and the ABI is fetched automatically, so functions are
picked from what the contract actually declares rather than typed from memory.
Parameter conditions are then labelled with real names (`vault (address)`), not
positions.

- **Source order**: Sourcify first — multi-chain and needs no API key — then
  Etherscan V2 if `ETHERSCAN_API_KEY` is set.
- **Proxies are followed.** Sourcify reports the implementation, and its ABI is
  what gets used: scoping a permission on USDC needs `transfer`, which the proxy
  itself does not declare.
- **Read-only functions are shown but marked**, because seeing that a function is
  a getter is what explains why granting it achieves nothing.
- **Unverified contracts**: paste an ABI instead, either as a JSON array or as
  one human-readable signature per line. A manual ABI is stored per chain and
  address, is reused next time, and is never overwritten by a later lookup.

Imported policy is made readable the same way. The modifier stores only 4-byte
selectors, so:

- when the target's ABI is available, a matching signature is adopted
  automatically — taken from the ABI, it hashes to that selector by construction;
- otherwise selectors are resolved in bulk against a signature directory and
  offered as *suggestions*, marked `?`. A selector is a truncated hash, so where
  several signatures collide you pick which one the contract declares. Nothing is
  adopted until it verifies against the stored selector.

## Multi-chain

Chain coverage follows the Roles indexer, so the app never offers a chain whose
policy it cannot read. Inside the Safe UI, a Safe's modifiers are discovered on
**every** indexed chain, not just the one the Safe is open on — a Safe can only
govern a modifier on its own chain, but seeing the rest is how you find its full
footprint. Off-chain entries are listed read-only and never auto-opened.

With a wallet connected, a modifier on another chain offers a one-click network
switch (`wallet_switchEthereumChain`) rather than silently planning a batch that
could not be submitted.

## Submitting

Two paths, both without a Transaction Service API key:

- **As a Safe App.** The Safe UI is authoritative for the Safe, chain and owner
  set; the batch is queued through the host. Add the app by URL in the Safe UI —
  `/manifest.json` is a route handler, not a static file, because the Safe fetches
  it cross-origin and it therefore needs CORS headers that `public/` cannot carry.
- **With a Safe-aware wallet.** Wallets with native Safe support (Rabby, among
  others) expose the Safe itself as the connected account and turn a transaction
  from it into a Safe transaction. Batches go through EIP-5792 `wallet_sendCalls`
  when the wallet supports it; otherwise each call is a separate confirmation,
  which the UI states plainly because a partially-applied policy is a real
  outcome.

Submission references retain their actual type instead of treating every wallet
response as a Safe transaction hash:

- a Safe App proposal returns a `safeTxHash`, which can be linked to the Safe
  queue;
- an atomic EIP-5792 submission returns a `bundleId`, which belongs to the
  connected wallet and is queried with `wallet_getCallsStatus`;
- sequential fallback returns `txHashes`, one per confirmed call. Those are
  chain transaction hashes, and partial completion is possible.

Proposal history is a best-effort record of what this console submitted. The
Safe or wallet remains authoritative for acceptance, confirmations, execution,
and failure; a local history row is not cryptographic proof that a proposal
executed.

Because Roles configuration calls are only accepted from the modifier's owner,
the connected account must be **the owning Safe** — an owner EOA signing directly
would revert. That is checked before submission rather than discovered after.

Outside both paths the console still runs read-only: inspect any modifier's
indexed policy snapshot and plan a diff, but nothing can be submitted.

Before enabling submission, three conditions are verified: the Safe owns the
modifier, the modifier's avatar is that Safe, and the modifier is an enabled
module on it.

## Persistence

Drafts, revisions, proposal history, and ABIs are stored in Cloudflare D1 via
Drizzle. User-authored rows are scoped first by the authenticated ChatGPT
identity and then by `(chainId, rolesMod)`, so one signed-in user cannot read or
mutate another user's workspace. A draft records a fingerprint of the state it
was based on, so reopening it warns when the modifier has moved on underneath.
Verified-source ABI cache rows are separate from authoritative per-user manual
entries.

The database is optional. With no binding, authenticated persistence is not
offered; indexed policy reads, planning, and submission are unaffected.

`db/ddl.ts` is the source of truth for both migrations.
`drizzle/0000_init.sql` retains the original anonymous schema for deployment
history; `drizzle/0001_authenticated_persistence.sql` creates the tenant-scoped
tables used by the application. Anonymous rows are intentionally not migrated
because they have no trustworthy owner. Tests fail if either generated migration
drifts.

```bash
npm run db:generate   # regenerate the checked-in migration files
```

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Validation:

```bash
npm test          # typecheck, lint, unit/schema tests, build, then rendered checks
```

`npm run typecheck`, `npm run lint`, `npm run test:unit`, and
`npm run test:rendered` remain available for focused local checks. CI runs the
full `npm test` gate on the minimum supported Node.js release and Node.js 24.

`GET /api/health` reports whether the route layer and D1 binding are reachable.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DB` (D1 binding) | no | Authenticated drafts, proposal history, and ABI cache. Without it, persistence is not offered. |
| `ETHERSCAN_API_KEY` | no | Fallback ABI source for contracts Sourcify has not verified. |

## Scope

The condition editor covers per-parameter constraints: equality, equality to the
avatar, numeric bounds, and allowance limits. Richer shapes — nested boolean
logic, matching inside tuples, bitmasks — are read and preserved but authored in
the Zodiac Roles app. Delegatecall permissions are read and flagged Critical, and
proposing a batch that enables one is blocked here.

## Icons

`npm run icons` regenerates `public/favicon.svg` plus PNG fallbacks from one
definition in `scripts/generate-icons.ts`. The mark is drawn as paths, not text:
an SVG favicon cannot rely on a font being installed, so letterforms would shift
or disappear depending on the viewer's system. Colours match the in-app brand
mark, so the browser tab reads as the same product.

## Reading a permission

Functions are shown with their declared parameter names —
`transfer(address to, uint256 value)`, not `transfer(address,uint256)` — the form
explorers and the Zodiac Roles app both use. A types-only signature leaves a
reviewer guessing which argument is the recipient and which is the amount, which
is the judgement a permission review turns on. It also makes near-identical
functions indistinguishable: three `approve(address,uint256)` rows are really
`spender/amount`, `usr/wad` and `spender/value` on three different contracts.

Names come from each target's ABI, batch-resolved for the open role, and the
canonical signature is always what the selector hashes from. The readable form is
display metadata and cannot reach calldata — a test asserts that a label naming a
*different* function changes nothing about what gets encoded.

## Limitations

- Sites access policy is the outer deployment gate, while persisted user data is
  keyed from the authenticated ChatGPT identity supplied by Sites. Authentication
  controls stored drafts/history; it does not replace Safe ownership checks or
  authorize an on-chain transaction. Do not place the Worker behind a proxy that
  allows clients to forge the `oai-authenticated-user-*` headers.
- Indexer freshness and ABI provenance have the trust boundaries described
  above. Reloading reduces staleness but does not turn either source into an
  on-chain proof.
- The Safe App handshake and `wallet_sendCalls` are exercised against a stub, not
  a real Safe iframe or wallet session.
- The deploy-and-enable batch has not been executed on-chain. Try it on a testnet
  before pointing it at a Safe holding funds.
