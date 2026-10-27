import { useCallback, useEffect, useRef, useState } from "react";
import { clearSavedForm, parseScopeFormState, readSavedForm, writeSavedForm, type ScopeFormState } from "./form-drafts";

const SAVE_DELAY_MS = 400;

/**
 * Chain/address inputs that survive a reload. A saved value is applied only if the
 * user has not typed yet, so a slow read never replaces what they are entering.
 */
export function useScopeForm(key: string, defaultChainId = 1): {
  chainId: number;
  address: string;
  setChainId: (chainId: number) => void;
  setAddress: (address: string) => void;
} {
  const [state, setState] = useState<ScopeFormState>({ chainId: defaultChainId, address: "" });
  const touched = useRef(false);
  const restored = useRef(false);

  useEffect(() => {
    let active = true;
    void readSavedForm(key, parseScopeFormState).then((saved) => {
      if (!active || !saved || touched.current) return;
      restored.current = true;
      setState(saved.data);
    });
    return () => { active = false; };
  }, [key]);

  useEffect(() => {
    if (!touched.current && !restored.current) return;
    const timer = window.setTimeout(() => {
      if (!state.address) void clearSavedForm(key);
      else void writeSavedForm(key, state).catch(() => {});
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [key, state]);

  const setChainId = useCallback((chainId: number) => { touched.current = true; setState((current) => ({ ...current, chainId })); }, []);
  const setAddress = useCallback((address: string) => { touched.current = true; setState((current) => ({ ...current, address })); }, []);
  return { ...state, setChainId, setAddress };
}
