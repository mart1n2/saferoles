// SPDX-License-Identifier: LGPL-3.0-or-later
// Adapted from Zodiac Roles SDK 3.4.8 (Gnosis Guild contributors).
// Source, modifications and license: see NOTICE.md in this directory.
import { diffAll } from './diff/all';
import type { Role, Allowance } from 'zodiac-roles-sdk';
export { encodeCalls } from './encode-calls';
export type { Call } from './call-types';

export function callsPlannedForApply(current: {roles: Role[]; allowances: Allowance[]}, desired: {roles: Role[]; allowances: Allowance[]}) {
  const {minus, plus} = diffAll({prev: current, next: desired});
  return [...minus, ...plus];
}
