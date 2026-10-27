// SPDX-License-Identifier: LGPL-3.0-or-later
// Adapted from Zodiac Roles SDK 3.4.8 (Gnosis Guild contributors).
// Source, modifications and license: see NOTICE.md in this directory.
import { Allowance, Role } from "zodiac-roles-sdk"
import { diffRoles } from "./role"
import { diffAllowances } from "./allowances"

import { Diff, merge } from "./helpers"

export function diffAll({
  prev,
  next,
}: {
  prev: { roles: Role[]; allowances: Allowance[] } | undefined | null
  next: { roles: Role[]; allowances: Allowance[] } | undefined | null
}): Diff {
  return merge(
    diffRoles({
      prev: prev?.roles,
      next: next?.roles,
    }),
    diffAllowances({
      prev: prev?.allowances,
      next: next?.allowances,
    })
  )
}
