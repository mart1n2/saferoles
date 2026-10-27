import { useEffect, useMemo, useState } from "react";
import { verifyModifier, type SafeContext } from "./use-safe";
import { verifyWalletForModifier, type WalletState } from "./use-wallet";
import type { PolicyState } from "./use-policy";
import type { SetupSubmitter } from "../setup-page";

export function useSubmissionContext(safe: SafeContext, wallet: WalletState, policy: PolicyState) {
  // Two submission paths. Inside the Safe UI the host is authoritative; outside
  // it, a Safe-aware wallet connected as the Safe itself can submit directly.
  const submitVia: "safe-app" | "wallet" | "none" =
    safe.mode === "safe-app"
      ? "safe-app"
      : wallet.status === "connected"
        ? "wallet"
        : "none";

  const moduleProbeKey =
    policy.scope && submitVia !== "none"
      ? [
          submitVia,
          wallet.connectionId ?? "safe-host",
          policy.scope.chainId,
          policy.scope.rolesMod.toLowerCase(),
          (submitVia === "safe-app"
            ? safe.info?.safeAddress
            : wallet.account
          )?.toLowerCase() ?? "",
        ].join(":")
      : null;
  const [moduleProbe, setModuleProbe] = useState<{
    key: string;
    enabled: boolean | null;
  } | null>(null);
  const checkSafeModule = safe.isModuleEnabled;
  const inspectWalletSafe = wallet.inspectSafe;

  useEffect(() => {
    if (!policy.scope || !moduleProbeKey || submitVia === "none") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const enabled =
          submitVia === "safe-app"
            ? await checkSafeModule(policy.scope!.rolesMod)
            : wallet.account
              ? (
                  await inspectWalletSafe(
                    wallet.account,
                    policy.scope!.rolesMod,
                  )
                ).moduleEnabled
              : null;
        if (!cancelled) {
          setModuleProbe({ key: moduleProbeKey, enabled });
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    moduleProbeKey,
    policy.scope,
    checkSafeModule,
    inspectWalletSafe,
    submitVia,
    wallet.account,
  ]);

  const moduleEnabled =
    moduleProbe?.key === moduleProbeKey ? moduleProbe.enabled : null;

  const verification = useMemo(() => {
    if (submitVia === "wallet") {
      return verifyWalletForModifier({
        account: wallet.account,
        chainId: wallet.chainId,
        owner: policy.facts?.owner ?? null,
        avatar: policy.facts?.avatar ?? null,
        target: policy.facts?.target ?? null,
        modifierChainId: policy.scope?.chainId ?? null,
        safeStatus: wallet.safeInspection.status,
        moduleEnabled,
      });
    }
    return verifyModifier({
      info: safe.info,
      owner: policy.facts?.owner ?? null,
      avatar: policy.facts?.avatar ?? null,
      target: policy.facts?.target ?? null,
      rolesMod: policy.scope?.rolesMod ?? "",
      chainId: policy.scope?.chainId ?? null,
      moduleEnabled,
    });
  }, [
    moduleEnabled,
    policy.facts,
    policy.scope,
    safe.info,
    submitVia,
    wallet.account,
    wallet.chainId,
    wallet.safeInspection.status,
  ]);

  /**
   * The Safe that setup would deploy for.
   *
   * In the Safe UI the host names it. With a Safe-aware wallet the connected
   * account *is* the Safe, so setup works there too — the same reason that path
   * can submit policy changes at all.
   */
  const setupSafeAddress =
    safe.info?.safeAddress ??
    (submitVia === "wallet" && wallet.safeInspection.status === "valid"
      ? wallet.account
      : null);
  const setupChainId =
    submitVia === "safe-app" ? safe.info?.chainId ?? null : wallet.chainId;

  // Whichever route can actually submit a batch, exposed uniformly so setup does
  // not need to know which one is active.
  const setupSubmitter = useMemo<SetupSubmitter | null>(() => {
    if (submitVia === "safe-app") {
      if (!safe.info || safe.info.isReadOnly) return null;
      return {
        label: "the Safe queue",
        submit: safe.propose,
        getCode: safe.getCode,
        readContract: safe.readContract,
        chainId: safe.info.chainId,
        atomic: true,
        safeVerified: true,
      };
    }
    if (submitVia === "wallet") {
      if (wallet.chainId === null) return null;
      return {
        label: "your wallet",
        // A verified Safe account may submit the two setup calls one after the
        // other: deploying first and enabling last means an interrupted run only
        // leaves an unused, not-yet-enabled modifier.
        submit: wallet.batchSupport === "atomic" ? wallet.sendAtomic : wallet.send,
        getCode: wallet.getCode,
        readContract: wallet.readContract,
        chainId: wallet.chainId,
        atomic: wallet.batchSupport === "atomic",
        atomicDetail: wallet.batchDetail,
        sequential: wallet.batchSupport !== "atomic",
        safeVerified: wallet.safeInspection.status === "valid",
      };
    }
    return null;
  }, [
    safe.getCode,
    safe.readContract,
    safe.info,
    safe.propose,
    submitVia,
    wallet.batchSupport,
    wallet.batchDetail,
    wallet.chainId,
    wallet.getCode,
    wallet.readContract,
    wallet.safeInspection.status,
    wallet.sendAtomic,
    wallet.send,
  ]);

  return { submitVia, verification, setupSafeAddress, setupChainId, setupSubmitter };
}
