import { useState } from "react";
import { chainName } from "../lib/chains";
import { normalizeContractAddress, type LocalContract } from "../lib/contract-labels";
import { useLocalContracts } from "../lib/use-local-contracts";
import { useContractLabel } from "../lib/use-contract-label";
import { ContractName } from "./contract-name";

function ContractRow({ contract, onRemove, busy }: { contract: LocalContract; onRemove: () => void; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const label = useContractLabel(contract.chainId, contract.address);
  return <article className="local-contract-row">
    <div className="local-contract-copy">
      <b><ContractName chainId={contract.chainId} address={contract.address} label={contract.label}/></b>
      <code>{contract.address}</code>
      {editing && <label className="modal-field"><span>Custom label</span><input aria-label={`Label for ${contract.address}`} value={label.value ?? contract.label} maxLength={256} placeholder="Leave empty to use the token symbol or contract name" onChange={(event) => label.save(event.target.value)}/><small>{label.error || (label.saving ? "Saving locally…" : "Saved locally. An empty label uses the automatic name.")}</small></label>}
    </div>
    <div className="local-contract-actions">
      <button type="button" className="button secondary" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit label"}</button>
      <button type="button" className="button ghost" disabled={busy} onClick={onRemove}>Remove</button>
    </div>
  </article>;
}

export function LocalContractsPanel({ chainId }: { chainId: number }) {
  const contracts = useLocalContracts(chainId);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [removed, setRemoved] = useState<LocalContract | null>(null);
  let normalized: string | null = null;
  try { normalized = normalizeContractAddress(address); } catch { /* Incomplete address. */ }
  return <section className="single-panel">
    <div className="panel-heading"><div><span className="eyebrow">Local address list · {chainName(chainId)}</span><h3>Contract whitelist</h3><p>Save contracts for the permission editor. This list is shared across your Roles configurations on this network, in this browser. It does not grant on-chain permissions.</p></div></div>
    <div className="local-contract-content">
      <form className="local-contract-form" onSubmit={(event) => {
        event.preventDefault();
        if (!normalized || contracts.busy) return;
        void contracts.add(normalized, label.trim() || undefined).then(() => { setAddress(""); setLabel(""); setRemoved(null); }).catch(() => {});
      }}>
        <label className="modal-field"><span>Contract address</span><input className="mono-input" aria-label="Whitelist contract address" placeholder="0x…" value={address} onChange={(event) => setAddress(event.target.value)}/><small>{address && !normalized ? "Enter a complete contract address." : "Letter case is ignored; saved addresses use checksum formatting."}</small></label>
        <label className="modal-field"><span>Label <small>(optional)</small></span><input aria-label="Whitelist contract label" placeholder="Token symbol is read automatically" maxLength={256} value={label} onChange={(event) => setLabel(event.target.value)}/></label>
        <button className="button primary" disabled={!normalized || contracts.busy}>{contracts.busy ? "Saving…" : "Add contract"}</button>
      </form>
      {contracts.error && <p className="error-text" role="alert">{contracts.error}</p>}
      {removed && <p className="local-contract-notice" role="status">Removed from the local whitelist. <button type="button" className="link-button" disabled={contracts.busy} onClick={() => { void contracts.add(removed.address).then(() => setRemoved(null)).catch(() => {}); }}>Undo</button></p>}
      {contracts.loading ? <p role="status">Loading local contracts…</p> : contracts.contracts.length === 0 ? <div className="empty-state compact"><h3>No saved contracts</h3><p>Add a contract to select it directly when creating a permission.</p></div> : <div className="local-contract-list">{contracts.contracts.map((contract) => <ContractRow key={contract.address} contract={contract} busy={contracts.busy} onRemove={() => { void contracts.remove(contract.address).then(() => setRemoved(contract)).catch(() => {}); }}/>)}</div>}
    </div>
  </section>;
}
