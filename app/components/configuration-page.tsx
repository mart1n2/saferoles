import type { ReactNode } from "react";
import { WalletControl } from "./wallet-control";
import { chainName } from "../lib/chains";
import type { WalletState } from "../lib/use-wallet";
/** Configuration is a document-sized workspace, never a nested modal. The wallet stays pinned in the sticky header. */
export function ConfigurationPage({children,onBack,backLabel,busy=false,wallet,requiredChainId}:{children:ReactNode;onBack:()=>void;backLabel:string;busy?:boolean;wallet?:WalletState|null;requiredChainId?:number|null}) {
  const wrongChain=Boolean(wallet?.account && requiredChainId && wallet.chainId!==requiredChainId);
  return <main className="configuration-page">
    <header className="scope-topbar">
      <span className="brand"><span className="brand-mark" aria-hidden="true">SR</span><span>SafeRoles</span></span>
      <div className="scope-tools">
        {wallet && <>
          {wrongChain && <button className="button secondary" disabled={busy} onClick={()=>void wallet.switchChain(requiredChainId!).catch(()=>{})}>Switch to {chainName(requiredChainId!)}</button>}
          <WalletControl wallet={wallet}/>
        </>}
        <button className="button secondary" disabled={busy} onClick={onBack}>← {backLabel}</button>
      </div>
    </header>
    <div className="configuration-content">{children}</div>
  </main>;
}
