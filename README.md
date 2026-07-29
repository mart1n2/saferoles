# SafeRoles

RBAC policy control, based on **Zodiac Roles**, with Safe-native approvals.

SafeRoles is a policy-management UI for creating and reviewing Zodiac Roles
configuration, then proposing the encoded calls to a Safe for threshold
approval. The connected wallet must be a Safe owner, and the configured Safe
must own and control the Roles Modifier.

## Current capabilities

- manage roles, members, scoped functions, parameter conditions, and allowances
- show the pending policy diff with explicit risk labels
- encode Roles Modifier calls without a privileged backend
- verify the signer, Safe owner set, Roles Modifier owner, and avatar
- sign and submit a multisend proposal to the Safe Transaction Service
- export the draft policy as JSON

The included workspace is a demo baseline, not a live onchain policy import.
Replace its sample addresses and conditions before proposing a transaction.

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Validation:

```bash
npm test
npx tsc --noEmit
npm run lint
```

Safe Transaction Service API keys are kept only in browser memory and are not
persisted by the application.
