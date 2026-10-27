# Local Zodiac planning compatibility

These files adapt the pure full-state diff, call types and transaction encoder
from `zodiac-roles-sdk` 3.4.8, by Gnosis Guild contributors, licensed under
LGPL-3.0-or-later. They are source code, retained in editable form, not a bundled
copy of the legacy SDK or a replacement for the Roles contracts.

Upstream source: https://github.com/zodiaceco/zodiac-modifier-roles-v2/tree/301e1db1c7e6225f166b28f5dc05b9e2133b76c9/packages/sdk/src/main

npm provenance: version 3.4.8; integrity
`sha512-3ldikfvxz3bQdkA8cT+4jjLkNI+CxQuPg6j/ig9jnU4HoT6MneU8cOSdkiA+d8ARIlVxvyEpYfhRtzELNYBTcA==`.
The source was recovered from the published package's source maps and type
declarations. Original paths are `target/diff/{annotations,members,helpers,
function,target,role,allowances,all}.ts`, `target/calls/{Call,encodeCalls}.ts`,
and `groupBy.ts`.

Modifications (2026-10-27): imports now use SDK v4's public condition utilities,
types and `rolesAbi`; only full-state planning is exposed; grouping uses
`PropertyKey`. Execution-flag swaps (Send ↔ DelegateCall) are detected using
bit differences; restrictive updates are emitted once, before grants. The v3
helper missed these swaps. No hosted apply, license-plan lookup or execution API is copied.
Safe approval and submission continue through the app's existing submission layer.
The app's allowance balance/timestamp diff correction remains in `policy-plan.ts`.

SDK v4 continues to own permission construction, normalization and integrity
checks. The local code owns diff ordering and call encoding. Regression vectors
in `tests/fixtures/zodiac-v3-plans.json` were generated against the unmodified
v3 package before migration. Production has no v3 dependency.

License texts: `COPYING.LESSER` (LGPLv3) and `COPYING` (GPLv3), alongside these
sources. Preserve this notice and license texts when redistributing the code.
