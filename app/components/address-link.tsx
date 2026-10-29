import { useState } from "react";
import { shortHex } from "../lib/abi";
import { addressExplorerUrl, explorerName } from "../lib/explorer";
import { useContractName } from "../lib/use-contract-name";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context and permission; fall back to selection.
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    try { return document.execCommand("copy"); } finally { document.body.removeChild(field); }
  }
}

/** Small copy icon. Always copies the full address, whatever text is shown next to it. */
export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const trimmed = address.trim();
  if (!trimmed) return null;
  return (
    <button
      type="button"
      className="copy-icon"
      aria-label={`Copy address ${trimmed}`}
      title={copied ? "Copied" : "Copy address"}
      onClick={async () => {
        if (await copyText(trimmed)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      )}
      <span className="sr-only" role="status">{copied ? "Copied" : ""}</span>
    </button>
  );
}

function ExplorerLink({ chainId, address, children }: { chainId: number | null; address: string; children: React.ReactNode }) {
  const url = addressExplorerUrl(chainId, address);
  if (!url) return <>{children}</>;
  return (
    <a className="address-link" href={url} target="_blank" rel="noopener noreferrer" title={`${address} — open in ${explorerName(chainId)}`} aria-label={`Open ${address} in ${explorerName(chainId)}`}>
      {children}
    </a>
  );
}

/**
 * An address the way a block explorer shows it: short, a link to the explorer,
 * with a small copy icon beside it. `full` keeps the whole address where it is
 * the thing being managed.
 */
export function AddressText({ chainId, address, full = false }: { chainId: number | null; address: string; full?: boolean }) {
  const trimmed = address.trim();
  if (!trimmed) return null;
  return (
    <span className="address-text">
      <ExplorerLink chainId={chainId} address={trimmed}><code>{full ? trimmed : shortHex(trimmed)}</code></ExplorerLink>
      <CopyAddress address={trimmed} />
    </span>
  );
}

/**
 * The best known name for an address, or the short address when there is none,
 * linked to the explorer with a copy icon that always copies the address.
 */
export function AddressLabel({ chainId, address, label, nameId }: { chainId: number; address: string; label?: string; nameId?: string }) {
  const trimmed = address.trim();
  const { name } = useContractName(chainId, trimmed, label);
  if (!trimmed) return <span id={nameId}>{label?.trim() || "New target"}</span>;
  return (
    <span className="address-text">
      <ExplorerLink chainId={chainId} address={trimmed}>
        <span id={nameId} className={name ? "address-name" : undefined}>{name ?? <code>{shortHex(trimmed)}</code>}</span>
      </ExplorerLink>
      <CopyAddress address={trimmed} />
    </span>
  );
}

/** Plain text in which every full address becomes an explorer link with a copy icon. */
export function TextWithAddresses({ chainId, text }: { chainId: number | null; text: string }) {
  return (
    <>
      {text.split(/(0x[0-9a-fA-F]{40})/g).map((part, index) =>
        /^0x[0-9a-fA-F]{40}$/.test(part) ? <AddressText key={index} chainId={chainId} address={part} /> : part,
      )}
    </>
  );
}
