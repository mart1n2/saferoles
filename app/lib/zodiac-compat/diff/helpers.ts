// SPDX-License-Identifier: LGPL-3.0-or-later
// Adapted from Zodiac Roles SDK 3.4.8 (Gnosis Guild contributors).
// Source, modifications and license: see NOTICE.md in this directory.
import { Clearance, ExecutionOptions } from "zodiac-roles-sdk"
import type { Call } from "../call-types"

export type Diff = {
  minus: Call[]
  plus: Call[]
}

export function merge(prev: Diff, next: Diff): Diff {
  return {
    minus: [...prev.minus, ...next.minus],
    plus: [...prev.plus, ...next.plus],
  }
}

export function isClearancePlus(
  prev: Clearance | undefined,
  next: Clearance | undefined
) {
  prev = prev || Clearance.None
  next = next || Clearance.None

  if (prev === Clearance.None && next !== Clearance.None) {
    return true
  }

  if (prev === Clearance.Function && next === Clearance.Target) {
    return true
  }

  return false
}

export function isClearanceMinus(
  prev: Clearance | undefined,
  next: Clearance | undefined
) {
  prev = prev || Clearance.None
  next = next || Clearance.None

  if (next === Clearance.Function && prev === Clearance.Target) {
    return true
  }

  if (next === Clearance.None && prev !== Clearance.None) {
    return true
  }

  return false
}

export function isExecutionOptionsPlus(prev: ExecutionOptions, next: ExecutionOptions) {
  return (next & ~prev) !== 0;
}

export function isExecutionOptionsMinus(prev: ExecutionOptions, next: ExecutionOptions) {
  return (prev & ~next) !== 0;
}
