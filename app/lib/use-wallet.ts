/** wagmi owns connection/account/network events; viem owns selected-provider RPC. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfig, useConnect, useConnection, useConnectors, useSwitchChain } from "wagmi";
import { disconnectWallets } from "./wallet-config";
import { createWalletRpc, idleSafeInspection, type WalletProvider, type WalletSafeInspection, type WalletTransaction, type BatchSupport } from "./wallet-rpc";
import type { SubmissionResult } from "./submission";
export type { WalletSafeInspection, WalletTransaction, BatchSupport } from "./wallet-rpc";
/** Wallets announce an icon as a data URI; anything else (remote URLs) is ignored. */
export function safeWalletIcon(icon: unknown): string | null {
  return typeof icon === "string" && /^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i.test(icon) ? icon : null;
}
export type WalletStatus = "unavailable" | "disconnected" | "connecting" | "connected";
export type WalletState = {
  status: WalletStatus; account: string | null; chainId: number | null; error: string | null;
  walletName: string | null; connectionId: string | null; walletIcon: string | null; wallets: {id:string; name:string; icon: string | null}[]; batchSupport: BatchSupport; batchDetail: string;
  connect: (connectorId?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  send: (transactions: WalletTransaction[]) => Promise<SubmissionResult>;
  sendAtomic: (transactions: WalletTransaction[]) => Promise<SubmissionResult>;
  switchChain: (chainId: number) => Promise<void>;
  getCode: (address: string) => Promise<string | null>;
  readContract: (to: string, data: string) => Promise<string | null>;
  safeInspection: WalletSafeInspection;
  inspectSafe: (safeAddress: string, moduleAddress?: string) => Promise<WalletSafeInspection & {moduleEnabled:boolean|null}>;
};

export function useWallet(): WalletState {
  const config = useConfig();
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connectAsync, isPending } = useConnect();
  const { mutateAsync: switchAsync } = useSwitchChain();
  const [error, setError] = useState<string | null>(null);
  const account = connection.address ?? null;
  const chainId = connection.chainId ?? null;
  const connector = connection.connector;
  const status: WalletStatus = connection.status === "connected" ? "connected" : isPending || connection.status === "reconnecting" || connection.status === "connecting" ? "connecting" : "disconnected";
  const identity = account && chainId !== null && connector ? `${connector.uid}:${account.toLowerCase()}:${chainId}` : null;
  const [probe, setProbe] = useState<{identity:string; support:BatchSupport; detail:string; inspection:WalletSafeInspection} | null>(null);

  const getRpc = useCallback(async () => {
    if (!account || chainId === null || !connector) throw new Error("Connect a wallet before submitting.");
    const assertCurrent = () => {
      const active = config.state.current ? config.state.connections.get(config.state.current) : undefined;
      if (!active || active.connector.uid !== connector.uid || active.accounts[0]?.toLowerCase() !== account.toLowerCase() || active.chainId !== chainId) {
        throw new Error("The wallet connection changed. Review again before submitting.");
      }
    };
    assertCurrent();
    const provider = await connector.getProvider({chainId}) as WalletProvider | undefined;
    assertCurrent();
    if (!provider || typeof provider.request !== "function") throw new Error("The selected wallet provider is unavailable.");
    return createWalletRpc(provider,{account,chainId},assertCurrent);
  }, [account, chainId, connector, config]);

  useEffect(() => {
    if (!identity || status !== "connected") return;
    let cancelled=false;
    void (async()=> {
      try {
        const rpc=await getRpc();
        const [support,inspection]=await Promise.all([rpc.capabilities(),rpc.inspectSafe(account!)]);
        if(!cancelled)setProbe({identity,support,detail:rpc.capabilityDetail(),inspection});
      } catch(caught) {
        if(!cancelled)setProbe({identity,support:"sequential",detail:"",inspection:{...idleSafeInspection,status:"unknown",problem:caught instanceof Error ? caught.message : "Could not verify wallet."}});
      }
    })();
    return ()=>{cancelled=true;};
  }, [identity,status,getRpc,account]);

  const connect = useCallback(async (connectorId?:string)=>{
    setError(null);
    setProbe(null);
    try {
      const chosen=connectorId ? connectors.find(item=>item.uid===connectorId) : connectors.length===1 ? connectors[0] : undefined;
      if(!chosen)throw new Error("Choose which wallet to connect.");
      await connectAsync({connector:chosen});
    } catch(caught) { setError(caught instanceof Error ? caught.message : "Wallet connection failed."); throw caught; }
  },[connectAsync,connectors]);
  const disconnect = useCallback(async()=>{
    setError(null);setProbe(null);
    try {await disconnectWallets(config);}
    catch(caught){setError(caught instanceof Error ? caught.message : "Wallet disconnect failed.");throw caught;}
  },[config]);
  const switchChain=useCallback(async(next:number)=>{
    setError(null);
    try {await switchAsync({chainId:next});}
    catch(caught){setError(caught instanceof Error ? caught.message : "Network switch failed.");}
  },[switchAsync]);
  const send=useCallback<WalletState["send"]>(async txs=>(await getRpc()).send(txs),[getRpc]);
  const sendAtomic=useCallback<WalletState["send"]>(async txs=>(await getRpc()).send(txs,true),[getRpc]);
  const getCode=useCallback(async(address:string)=>{try{return await (await getRpc()).getCode(address);}catch{return null;}},[getRpc]);
  const readContract=useCallback(async(to:string,data:string)=>{try{return await (await getRpc()).readContract(to,data);}catch{return null;}},[getRpc]);
  const inspectSafe=useCallback<WalletState["inspectSafe"]>(async(safe,module)=>{
    try{return await (await getRpc()).inspectSafe(safe,module);}
    catch(caught){return {...idleSafeInspection,status:"unknown",problem:caught instanceof Error ? caught.message : "Wallet unavailable.",moduleEnabled:null};}
  },[getRpc]);
  const currentProbe = probe?.identity===identity ? probe : null;
  const wallets = useMemo(()=>connectors.filter(item=>item.id!=="injected" || connectors.length===1).map(item=>({id:item.uid,name:item.id==="injected" ? "Browser wallet" : item.name,icon:safeWalletIcon(item.icon)})),[connectors]);
  return {status,account,chainId,error,connectionId:identity,walletName:connector?.name ?? null,walletIcon:safeWalletIcon(connector?.icon),wallets,connect,disconnect,switchChain,send,sendAtomic,getCode,readContract,inspectSafe,batchSupport:currentProbe?.support ?? "sequential",batchDetail:currentProbe?.detail ?? "",safeInspection:currentProbe?.inspection ?? {...idleSafeInspection,status:status==="connected"?"checking":"idle"}};
}
/**
 * Checks a wallet connection against the modifier it is about to reconfigure.
 *
 * The connected account must be the modifier's owner. With a Safe-aware wallet
 * that means selecting the Safe account itself; an owner EOA would have its
 * transaction rejected by the modifier.
 */
export function verifyWalletForModifier({
  account,
  chainId,
  owner,
  avatar,
  target,
  modifierChainId,
  safeStatus,
  moduleEnabled,
}: {
  account: string | null;
  chainId: number | null;
  owner: string | null;
  avatar: string | null;
  target: string | null;
  modifierChainId: number | null;
  safeStatus: WalletSafeInspection["status"];
  moduleEnabled: boolean | null;
}): { ok: boolean; problems: string[] } {
  if (!account) {
    return { ok: false, problems: ["Connect a wallet to submit changes."] };
  }

  const same = (a: string | null, b: string | null) =>
    Boolean(a && b && a.toLowerCase() === b.toLowerCase());

  const problems: string[] = [];
  if (modifierChainId !== null && chainId !== modifierChainId) {
    problems.push(
      `The wallet is on chain ${chainId ?? "unknown"} but this modifier is on chain ${modifierChainId}. Switch networks in your wallet.`,
    );
  }
  if (!same(account, owner)) {
    problems.push(
      `Only the modifier's owner (${owner ?? "unknown"}) can change its configuration. Select that Safe as the active account — signing from a personal wallet would be rejected.`,
    );
  }
  if (!same(account, avatar)) {
    problems.push(
      `The modifier acts on ${avatar ?? "an unknown avatar"}, not the connected Safe.`,
    );
  }
  if (!same(account, target)) {
    problems.push(
      `The modifier routes execution through ${target ?? "an unknown target"}, not the connected Safe.`,
    );
  }
  if (safeStatus !== "valid") {
    problems.push(
      safeStatus === "checking"
        ? "Verifying that the connected account is a Safe…"
        : safeStatus === "invalid"
          ? "The connected account is not a valid Safe. Select your Safe account rather than a personal wallet account."
          : "The connected account could not be verified as a Safe.",
    );
  }
  if (moduleEnabled !== true) {
    problems.push(
      moduleEnabled === false
        ? "The modifier is not an enabled module on the connected Safe."
        : "The modifier's enabled-module status could not be verified on chain.",
    );
  }

  return { ok: problems.length === 0, problems };
}
