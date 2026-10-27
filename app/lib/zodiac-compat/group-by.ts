// SPDX-License-Identifier: LGPL-3.0-or-later
// Adapted from Zodiac Roles SDK 3.4.8 (Gnosis Guild contributors).
// Source, modifications and license: see NOTICE.md in this directory.
export const groupBy = <T, K extends PropertyKey>(
  arr: readonly T[],
  key: (i: T) => K
) =>
  arr.reduce(
    (groups, item) => {
      ;(groups[key(item)] ||= []).push(item)
      return groups
    },
    {} as Record<K, T[]>
  )
