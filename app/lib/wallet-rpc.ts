/** Wallet RPC uses only the explicitly selected connector's provider. */
import { createPublicClient, createWalletClient, custom, getAddress, isAddress, parseAbi, type Address, type EIP1193Provider, type Hex } from "viem";
import { walletChains } from "./wallet-chains";
import { PartialSubmissionError, type SubmissionResult } from "./submission";

export type WalletTransaction = { to: string; value: string; data: string };
export type BatchSupport = "atomic" | "sequential";
export type WalletSafeInspection = {
  status: "idle" | "checking" | "valid" | "invalid" | "unknown";
  owners: string[]; threshold: number | null; problem: string | null;
};
export type WalletProvider = { request(args: {method: string; params?: unknown[] | object}): Promise<unknown> };
export const idleSafeInspection: WalletSafeInspection = { status: "idle", owners: [], threshold: null, problem: null };
const abi = parseAbi([
  "function VERSION() view returns (string)", "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)", "function nonce() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
]);

export function createWalletRpc(provider: WalletProvider, session: { account: string; chainId: number }, assertCurrent: () => void = () => {}) {
  const publicClient = createPublicClient({ transport: custom(provider as EIP1193Provider, { retryCount: 0 }) });
  const walletClient = createWalletClient({ transport: custom(provider as EIP1193Provider, { retryCount: 0 }) });
  async function checkSession() {
    assertCurrent();
    const [accounts, chain] = await Promise.all([
      provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
    ]);
    assertCurrent();
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== session.account.toLowerCase() || Number(chain) !== session.chainId) {
      throw new Error("The selected wallet account or network changed. Reconnect and review before submitting.");
    }
  }
  /** Why the last capability probe did not report atomic batches, for the UI. */
  let capabilityDetail = "";
  async function capabilities(): Promise<BatchSupport> {
    await checkSession();
    capabilityDetail = "";
    try {
      const result = await provider.request({ method: "wallet_getCapabilities", params: [session.account] }) as Record<string, { atomic?: {status?: string}; atomicBatch?: {supported?: boolean} }>;
      await checkSession();
      const current = result?.[`0x${session.chainId.toString(16)}`];
      const atomic = current?.atomic?.status === "supported" || current?.atomic?.status === "ready" || current?.atomicBatch?.supported;
      if (!atomic) capabilityDetail = current ? `wallet reported no atomic batch support on this network (${JSON.stringify(current).slice(0,160)})` : "wallet returned no capabilities for this network";
      return atomic ? "atomic" : "sequential";
    } catch (error) {
      await checkSession();
      capabilityDetail = `wallet_getCapabilities failed: ${error instanceof Error ? error.message : "unknown error"}`.slice(0,200);
      return "sequential";
    }
  }
  return {
    capabilities,
    capabilityDetail: () => capabilityDetail,
    async getCode(address: string): Promise<string | null> {
      try { await checkSession(); const code = await publicClient.getBytecode({address:getAddress(address)}); await checkSession(); return code ?? "0x"; }
      catch { return null; }
    },
    async readContract(to: string, data: string): Promise<string | null> {
      try { await checkSession(); const result = await publicClient.call({to:getAddress(to),data:data as Hex}); await checkSession(); return result.data ?? "0x"; }
      catch { return null; }
    },
    async inspectSafe(safe: string, module?: string): Promise<WalletSafeInspection & {moduleEnabled: boolean | null}> {
      try {
        await checkSession();
        if (!isAddress(safe) || (module && !isAddress(module))) throw new Error("The Safe or modifier address is invalid.");
        const checked = getAddress(safe);
        const code = await publicClient.getBytecode({address:checked});
        if (!code || code === "0x") return { ...idleSafeInspection, status:"invalid", problem:"A personal wallet account is connected. Open this Safe to approve changes, or select your Safe account in the wallet.", moduleEnabled:null };
        const [version, owners, threshold, nonce] = await Promise.all([
          publicClient.readContract({address:checked,abi,functionName:"VERSION"}),
          publicClient.readContract({address:checked,abi,functionName:"getOwners"}),
          publicClient.readContract({address:checked,abi,functionName:"getThreshold"}),
          publicClient.readContract({address:checked,abi,functionName:"nonce"}),
        ]);
        if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) || owners.length === 0 || threshold <= 0n || threshold > BigInt(owners.length) || nonce < 0n) {
          throw new Error("The connected contract did not return a valid Safe owner set and threshold.");
        }
        const moduleEnabled = module ? await publicClient.readContract({address:checked,abi,functionName:"isModuleEnabled",args:[getAddress(module)]}) : null;
        await checkSession();
        return {status:"valid",owners:owners.map(owner=>getAddress(owner)),threshold:Number(threshold),problem:null,moduleEnabled};
      } catch(error) {
        return {...idleSafeInspection,status:"unknown",problem:error instanceof Error ? error.message : "Could not verify this Safe.",moduleEnabled:null};
      }
    },
    async send(transactions: WalletTransaction[], requireAtomic = false): Promise<SubmissionResult> {
      if (!transactions.length) throw new Error("There is nothing to submit.");
      // Reject malformed batches before the first wallet confirmation.
      const calls = transactions.map(tx=>({to:getAddress(tx.to),data:tx.data as Hex,value:BigInt(tx.value)}));
      if (calls.some(tx=>tx.value < 0n || !/^0x(?:[a-f0-9]{2})*$/i.test(tx.data))) throw new Error("Invalid transaction data or value.");
      const support = await capabilities();
      if (requireAtomic && support !== "atomic") throw new Error("Atomic batch support is required for initialization.");
      await checkSession();
      if (support === "atomic") {
        const chain = walletChains.find(chain => chain.id === session.chainId);
        if (!chain) throw new Error("This network is not supported for submission.");
        const result = await walletClient.sendCalls({ account: getAddress(session.account), chain, calls, forceAtomic:true, experimental_fallback:false });
        if (!result.id) throw new Error("The wallet did not return a batch identifier.");
        return {kind:"bundleId",bundleId:result.id};
      }
      const txHashes: string[]=[];
      for(const call of calls) {
        try {
          await checkSession();
          txHashes.push(await walletClient.sendTransaction({...call,account:session.account as Address,chain:null}));
        } catch(error) {
          if(txHashes.length) throw new PartialSubmissionError(`${txHashes.length} of ${calls.length} calls were submitted. Reconcile them before retrying.`,txHashes,{cause:error});
          throw error;
        }
      }
      return {kind:"txHashes",txHashes};
    },
  };
}
