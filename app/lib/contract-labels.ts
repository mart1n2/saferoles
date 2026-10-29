import { getAddress } from "ethers";
import { localList, localRead, localUpdate } from "./local-db";

type ContractLabel = { version: 1; chainId: number; address: string; label: string; approved?: boolean };
export type LocalContract = { chainId: number; address: string; label: string };
export function normalizeContractAddress(address: string): string {
  return getAddress(address.trim().toLowerCase());
}
function scope(chainId: number, address: string) {
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("Invalid label network.");
  return { chainId, address: normalizeContractAddress(address).toLowerCase() };
}
export const contractLabelKey = (chainId: number, address: string) => ["contract-label", chainId, address.trim().toLowerCase()] as const;
export const localContractsKey = (chainId: number) => ["local-contracts", chainId] as const;

/** Address labels outlive policy drafts, submission and subsequent chain refreshes. */
export async function readContractLabel(chainId: number, address: string): Promise<string | null> {
  const checked = scope(chainId, address);
  const saved = await localRead<ContractLabel>("labels", `${chainId}:${checked.address}`);
  return saved?.version === 1 && saved.chainId === chainId && saved.address === checked.address && typeof saved.label === "string" && saved.label.length <= 256 ? saved.label : null;
}

export async function saveContractLabel(chainId: number, address: string, label: string): Promise<void> {
  const checked = scope(chainId, address);
  if (typeof label !== "string" || label.length > 256) throw new Error("A contract label must be at most 256 characters.");
  // Keep an explicit empty label so old policy copies cannot resurrect a removed label.
  await localUpdate<ContractLabel>("labels", `${chainId}:${checked.address}`, (current) => ({ version: 1, ...checked, label, ...(current?.approved === true ? { approved: true } : {}) }));
}

/** This local allowlist is an address picker, never an on-chain permission grant. */
export async function listLocalContracts(chainId: number): Promise<LocalContract[]> {
  const saved = await localList<ContractLabel>("labels");
  return saved.flatMap((entry) => {
    if (entry?.version !== 1 || entry.approved !== true || entry.chainId !== chainId || typeof entry.address !== "string" || typeof entry.label !== "string" || entry.label.length > 256) return [];
    try { return [{ chainId, address: normalizeContractAddress(entry.address), label: entry.label }]; }
    catch { return []; }
  }).sort((a, b) => (a.label || a.address).localeCompare(b.label || b.address));
}

export async function addLocalContract(chainId: number, address: string, label?: string): Promise<void> {
  const checked = scope(chainId, address);
  if (label !== undefined && (typeof label !== "string" || label.length > 256)) throw new Error("A contract label must be at most 256 characters.");
  await localUpdate<ContractLabel>("labels", `${chainId}:${checked.address}`, (current) => ({ version: 1, ...checked, label: label ?? current?.label ?? "", approved: true }));
}

export async function removeLocalContract(chainId: number, address: string): Promise<void> {
  const checked = scope(chainId, address);
  await localUpdate<ContractLabel>("labels", `${chainId}:${checked.address}`, (current) => current ? { ...current, approved: false } : undefined);
}
