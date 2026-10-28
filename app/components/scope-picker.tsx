import { ApiKeySettings } from "./api-key-settings";
import { WalletControl } from "./wallet-control";
import { useState } from "react";
import { isAddress } from "ethers";
import { chainName, chainOptionLabel, hasOfficialRoles, supportedChainIds, zodiacAppUrl } from "../lib/chains";
import { shortHex } from "../lib/abi";
import { formKeys } from "../lib/form-drafts";
import { useScopeForm } from "../lib/use-scope-form";
import { useDiscoveredMods, type Scope } from "../lib/use-policy";
import type { useSafe } from "../lib/use-safe";
import type { useWallet } from "../lib/use-wallet";

export function ScopePicker({ safe, wallet, mods, modsLoading, modsError, onSelect, onSetUp, onBack }: {
  safe: ReturnType<typeof useSafe>;
  wallet: ReturnType<typeof useWallet>;
  mods: { address: string; chainId: number; owner: string; avatar: string }[];
  modsLoading: boolean;
  modsError: string | null;
  onSelect: (scope: Scope) => void;
  onSetUp?: () => void;
  onBack?: () => void;
}) {
  const activeSafe = safe.info?.safeAddress ?? (wallet.safeInspection.status === "valid" ? wallet.account : null);
  const activeChain = safe.info?.chainId ?? wallet.chainId;
  const [lookup, setLookup] = useState<{ address: string; chainId: number } | null>(null);
  const { address, chainId, setAddress, setChainId } = useScopeForm(formKeys.scopeLookup());
  const [chooseAnother, setChooseAnother] = useState(false);
  const discovered = useDiscoveredMods(lookup?.address ?? null, lookup?.chainId ?? null);
  const selected = lookup ?? (activeSafe && activeChain !== null ? { address: activeSafe, chainId: activeChain } : null);
  const shownMods = lookup ? discovered.mods : mods;
  const loading = lookup ? discovered.loading : modsLoading;
  const error = lookup ? discovered.error : modsError;
  const canInitialize = Boolean(onSetUp && selected && hasOfficialRoles(selected.chainId) && activeSafe && selected.address.toLowerCase() === activeSafe.toLowerCase() && selected.chainId === activeChain);

  return <main className="app-shell scope-page">
    <header className="scope-topbar">
      <a className="brand" href="/" aria-label="SafeRoles home"><span className="brand-mark" aria-hidden="true">SR</span><span>SafeRoles</span></a>
      <div className="scope-tools">{onBack && <button className="button secondary" onClick={onBack}>← Back to editing</button>}<ApiKeySettings/>{safe.mode !== "safe-app" && <WalletControl wallet={wallet}/>}</div>
    </header>
    <div className="scope-content">
      <section className="scope-intro">
        <span className="eyebrow">RBAC management</span>
        <h1>{selected && !chooseAnother ? "Manage this Safe" : "Manage your Safe permissions"}</h1>
        <p>Inspect roles, manage members, and configure exactly what each role can do.</p>
      </section>
      <section className="scope-workspace" aria-label="Safe configuration">
        <div className="scope-panel-heading"><h2>{selected && !chooseAnother ? "Role configurations" : "Choose a Safe"}</h2><p>Open an existing configuration or initialize RBAC with your first role.</p></div>
    {(!selected || chooseAnother) ? <div className="connection-fields">
      <label className="modal-field"><span>Network</span><select value={chainId} onChange={event => setChainId(Number(event.target.value))}>
        {supportedChainIds.map(id => <option value={id} key={id}>{chainOptionLabel(id)}</option>)}
      </select>{!hasOfficialRoles(chainId) && <small className="field-help">The official Roles contract is not deployed here. You can look up existing configurations, but not set up a new one.</small>}</label>
      <label className="modal-field"><span>Safe address</span><input className="mono-input" value={address} placeholder="0x…" onChange={event => setAddress(event.target.value.trim())} />
        <small>Look up indexed Roles configurations by Safe address. Connecting a wallet is only needed to submit changes.</small>
      </label>
      <button className="button primary" disabled={!isAddress(address)} onClick={() => { setLookup({ address, chainId }); setChooseAnother(false); }}>Find role configurations</button>
      {selected && <button className="button ghost" onClick={() => setChooseAnother(false)}>Back to selected Safe</button>}
    </div> : <>
      <div className="selected-safe"><b>{chainName(selected.chainId)}</b><code>{selected.address}</code>
        <small>{canInitialize ? "Selected by your Safe host or verified Safe-aware wallet" : "Indexed lookup · submission authority has not been verified"}</small>
      </div>
      {loading && <p className="inline-empty">Looking up role configurations…</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="mod-list">{shownMods.map(mod => {
        const sameChain = mod.chainId === selected.chainId;
        const governed = mod.owner.toLowerCase() === selected.address.toLowerCase() && mod.avatar.toLowerCase() === selected.address.toLowerCase();
        return <button className="mod-option" key={`${mod.chainId}:${mod.address}`} onClick={() => onSelect({ chainId: mod.chainId, rolesMod: mod.address })}>
          <span><b>{shortHex(mod.address, 12, 10)}</b><small>{chainName(mod.chainId)} · {sameChain && governed ? "Owned by and acting on this Safe" : "Different chain or governance · inspect configuration"}</small></span>
          <span className={`health-badge ${sameChain && governed ? "" : "warn"}`}>{sameChain && governed ? "Open roles" : "Inspect"}</span>
        </button>;
      })}</div>
      {!loading && !error && shownMods.length === 0 && <div className="empty-state compact"><h3>No indexed role configurations</h3><p>This lookup does not prove that no module exists on chain. Initialize only if you intend to create a new Roles instance.</p></div>}
      {selected && !hasOfficialRoles(selected.chainId)
        ? <p className="inline-empty">The official Roles contract is not deployed on {chainName(selected.chainId)}, so a new Roles instance cannot be set up here.</p>
        : selected && <div className="official-init">
          <b>New here? Initialize in the official Zodiac app</b>
          <p>It runs inside Safe, is maintained by Gnosis Guild, and deploys and enables the Roles modifier for your Safe. Come back here afterwards to manage roles and permissions.</p>
          <div>
            {zodiacAppUrl(selected.chainId) && <a className="button primary" href={zodiacAppUrl(selected.chainId)!} target="_blank" rel="noopener noreferrer">Open Zodiac in Safe ↗</a>}
            {canInitialize && <button className="button ghost" onClick={onSetUp}>{shownMods.length ? "Set up another instance here" : "Set up here instead"}</button>}
          </div>
        </div>}
      <button className="button ghost" onClick={() => setChooseAnother(true)}>Choose another Safe</button>
    </>}
    {wallet.error && <p className="error-text">{wallet.error}</p>}
    <details className="advanced-entry"><summary>Advanced: open a modifier directly</summary><ScopeForm onSelect={onSelect} /></details>
    </section>
    <p className="scope-local-note">Drafts stay in this browser. Connecting a wallet does not grant permissions.</p>
    </div></main>;
}

function ScopeForm({
  initial,
  onSelect,
}: {
  initial?: Scope;
  onSelect: (scope: Scope) => void;
}) {
  const { address, chainId, setAddress, setChainId } = useScopeForm(formKeys.scopeModifier(), initial?.chainId ?? 1);
  const valid = isAddress(address);

  return (
    <div className="connection-fields">
      <label className="modal-field">
        <span>Chain</span>
        <select value={chainId} onChange={(event) => setChainId(Number(event.target.value))}>
          {supportedChainIds.map((id) => (
            <option key={id} value={id}>
              {chainOptionLabel(id)}
            </option>
          ))}
        </select>
      </label>
      <label className="modal-field">
        <span>Roles modifier address</span>
        <input
          className="mono-input"
          value={address}
          placeholder="0x…"
          onChange={(event) => setAddress(event.target.value.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && valid) onSelect({ chainId, rolesMod: address });
          }}
        />
        {address && !valid && (
          <small className="error-text">Enter a complete 20-byte address.</small>
        )}
      </label>
      <button
        className="button primary"
        disabled={!valid}
        onClick={() => onSelect({ chainId, rolesMod: address })}
      >
        Read policy
      </button>
    </div>
  );
}

