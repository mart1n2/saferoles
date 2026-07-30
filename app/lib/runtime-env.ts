/**
 * Runtime configuration published by the Worker entry point.
 *
 * Route handlers cannot reach `env`, so the entry point hands values over per
 * request. Everything here is optional: the app degrades to a source that needs
 * no key rather than failing.
 */

export type RuntimeVars = {
  /** Etherscan V2 multichain key. Optional; Sourcify needs no key. */
  ETHERSCAN_API_KEY?: string;
};

let vars: RuntimeVars = {};

export function setRuntimeVars(next: RuntimeVars): void {
  vars = next;
}

export function runtimeVar(name: keyof RuntimeVars): string | undefined {
  const value = vars[name];
  return value && value.trim() ? value.trim() : undefined;
}
