import { exportLocalDraft, importLocalDraft } from "../lib/local-workspace";
import type { DraftPolicy } from "../lib/policy";
import { useState } from "react";
import type { useDrafts, DraftSummary } from "../lib/use-drafts";
import { useDismissOnEscape } from "../lib/use-dismiss-on-escape";
export function DraftsDialog({
  policy,
  safeAddress,
  drafts,
  activeDraftId,
  currentBaseHash,
  canSave,
  onSave,
  onClose,
  onOpen,
  onDeleted,
}: {
  policy: DraftPolicy;
  safeAddress: string;
  drafts: ReturnType<typeof useDrafts>;
  activeDraftId: string | null;
  currentBaseHash: string | null;
  canSave: boolean;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
  onOpen: (summary: DraftSummary) => Promise<void>;
  onDeleted: (id:string) => void;
}) {
  const [name, setName] = useState("Policy update");
  const [message,setMessage]=useState<string|null>(null);
  const [importing,setImporting]=useState(false);
  async function save(){try{await onSave(name.trim());}catch(error){setMessage(error instanceof Error?error.message:"Could not save locally.");}}
  function download(){
    const now=Date.now();
    const content=exportLocalDraft({id:"export",name,chainId:policy.chainId,rolesMod:policy.rolesMod,safeAddress,policy,baseStateHash:currentBaseHash,createdBy:"This browser",version:1,createdAt:now,updatedAt:now});
    const url=URL.createObjectURL(new Blob([content],{type:"application/json"}));
    const anchor=document.createElement("a");anchor.href=url;anchor.download=`saferoles-${policy.chainId}-${policy.rolesMod}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  useDismissOnEscape(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal connection-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drafts-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Saved work</span>
            <h2 id="drafts-title">Drafts</h2>
            <p>Stored only in this browser. Export a backup before clearing browser data. Loading replaces the current edits.</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="boot-actions"><button className="button secondary" onClick={download}>Export current draft</button>
        <label className="button secondary">{importing?"Importing…":"Import JSON"}<input type="file" accept=".json,application/json" hidden disabled={importing} onChange={event=>{
          const file=event.target.files?.[0];event.target.value="";if(!file)return;
          if(file.size>2_000_000){setMessage("Draft file exceeds 2 MB.");return;}
          setImporting(true);setMessage(null);
          void file.text().then(importLocalDraft).then(async row=>{await drafts.refresh();setMessage(row.chainId===policy.chainId && row.rolesMod.toLowerCase()===policy.rolesMod.toLowerCase()?"Imported as a new local draft. Open it below.":"Imported for a different modifier. Open that modifier to find it.");}).catch(error=>setMessage(error instanceof Error?error.message:"Import failed.")).finally(()=>setImporting(false));
        }}/></label></div>
        {message && <p role="status" className="inline-empty">{message}</p>}
        {drafts.error && <p className="error-text">{drafts.error}</p>}
        {canSave && (
          <label className="modal-field">
            <span>Save current edits as</span>
            <div className="adopt-row">
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Draft name"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && name.trim()) void save();
                }}
              />
              <button
                className="button primary"
                disabled={!name.trim() || drafts.busy}
                onClick={() => void save()}
              >
                Save
              </button>
            </div>
          </label>
        )}
        <div className="mod-list">
          {drafts.drafts.map((summary) => {
            const stale =
              Boolean(summary.baseStateHash && currentBaseHash) &&
              summary.baseStateHash !== currentBaseHash;
            return (
              <div className="draft-row" key={summary.id}>
                <span>
                  <b>
                    {summary.name}
                    {summary.id === activeDraftId ? " · open" : ""}
                  </b>
                  <small>
                    {new Date(summary.updatedAt).toLocaleString()}
                    {summary.createdBy
                      ? ` · ${summary.createdBy.slice(0, 160)}`
                      : ""}
                    {stale ? " · based on older state" : ""}
                  </small>
                </span>
                <span className="draft-actions">
                  <button className="button secondary" onClick={() => void onOpen(summary).catch(error=>setMessage(error instanceof Error?error.message:"Could not open draft."))}>
                    Open
                  </button>
                  <button
                    className="row-remove"
                    aria-label={`Delete ${summary.name}`}
                    onClick={() => void drafts.remove(summary).then(removed=>{if(removed)onDeleted(summary.id);})}
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
          {drafts.drafts.length === 0 && (
            <p className="inline-empty">
              No drafts yet. Use “Save as draft” once you have changes.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

