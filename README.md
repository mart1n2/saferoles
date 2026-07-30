# SafeRoles

RBAC policy control for **Zodiac Roles**, with Safe-native approvals.

SafeRoles reads a Roles modifier's live on-chain configuration, lets you edit it,
and submits the exact difference for Safe approval. The diff a reviewer reads and
the calldata that gets signed are the same object — there is no separate edit log
that can drift from what is actually proposed.

## How it works

1. **Read live state.** The modifier's current policy (roles, members, targets,
   conditions, allowances) is read through the Zodiac Roles indexer, proxied by
   this app's Worker so it also works inside the Safe App iframe.
2. **Edit a draft** of that state.
3. **Plan continuously.** Every edit re-diffs draft against live state and
   produces the exact Roles calls needed, via `zodiac-roles-sdk`.
4. **Submit.** The batch goes to the Safe for threshold approval.

### Fidelity guarantees

These are the properties that make the diff trustworthy, each covered by a test:

- **Importing a policy and changing nothing plans nothing.** Verified against a
  live 4-role, 188-permission mainnet policy: zero calls.
- **Conditions the editor cannot represent are never rewritten.** Nested
  `and`/`or`, tuple matching and bitmasks are preserved byte-for-byte and shown
  read-only rather than approximated into something weaker.
- **Nothing is planned while any value is invalid.** An unencodable role is an
  *absent* role, and absence reads to the planner as "revoke everything in it".
  Issues therefore block the diff entirely instead of producing a plausible-looking
  mass revocation.
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
| Address is well formed | A corrupt checksum means a mistyped address. |
| Contract exists on this chain | `eth_getCode` is non-empty. |
| Source identifies as Roles | Published source names it `Roles` **and** declares the full Roles v2 interface. |
| Zodiac factory is available | Confirms the factory is deployed on this chain, or the deploy would revert. |
| Target address is unoccupied | Deploying over an existing proxy reverts. |

The mastercopy field is pre-filled with the address Zodiac deploys Roles v2 to on
every supported chain, but it is treated strictly as a *suggestion* — verified at
runtime like any other input, never trusted for being hardcoded. Replace it to
deploy from a different mastercopy.

The derived proxy address is shown before submission, and it is the same address
the encoded `enableModule` call enables. Change the salt to derive a different
one.

Setup works from the Safe UI, and from a Safe-aware wallet with the Safe selected
as the active account.

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

Because Roles configuration calls are only accepted from the modifier's owner,
the connected account must be **the owning Safe** — an owner EOA signing directly
would revert. That is checked before submission rather than discovered after.

Outside both paths the console still runs read-only: inspect any modifier's live
policy and plan a diff, but nothing can be submitted.

Before enabling submission, three conditions are verified: the Safe owns the
modifier, the modifier's avatar is that Safe, and the modifier is an enabled
module on it.

## Persistence

Drafts, revisions, proposal history and resolved ABIs are stored in Cloudflare D1 via Drizzle,
scoped by `(chainId, rolesMod)` so history survives role renames. A draft records
a fingerprint of the state it was based on, so reopening it warns when the
modifier has moved on underneath.

The database is optional. With no binding, drafts are simply not offered; live
policy and submission are unaffected.

`db/ddl.ts` is the source of truth for the schema; `drizzle/0000_init.sql` is
generated from it and a test fails if they drift.

```bash
npm run db:generate   # regenerate drizzle/0000_init.sql
```

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Validation:

```bash
npm test          # unit + schema tests, then build, then SSR checks
npx tsc --noEmit
npm run lint
```

`GET /api/health` reports whether the route layer and D1 binding are reachable.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DB` (D1 binding) | no | Drafts, proposal history, ABI cache. Without it, drafts are not offered. |
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

- **No authentication.** Drafts are scoped by `(chainId, rolesMod)`, which is
  public information, so anyone who can reach the deployment can read or modify
  them. Nothing can be submitted without the Safe or a Safe-aware wallet, and
  every proposal shows its full diff before signing, but a shared deployment
  should sit behind access control.
- The Safe App handshake and `wallet_sendCalls` are exercised against a stub, not
  a real Safe iframe or wallet session.
- The deploy-and-enable batch has not been executed on-chain. Try it on a testnet
  before pointing it at a Safe holding funds.
