import { useCallback, useMemo, useState } from "react";
import { isAddress } from "ethers";
import type { DraftAllowance, DraftPermission, DraftRole } from "./policy";
import type { PolicyState } from "./use-policy";
import { suggestRoleKey } from "./initialization";
import { useFunctionNames, useSelectorNames } from "./use-abi";
export const roleTabs = ["Permissions", "Members"] as const;
export const configTabs = ["Contracts", "Allowances", "Batching", "Activity"] as const;
export const tabs = [...roleTabs, ...configTabs] as const;
export type Tab = (typeof tabs)[number];
const nextId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export function usePolicyEditor(policy: PolicyState) {
  const [tab, setTab] = useState<Tab>("Permissions");
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selectedPermissionId, setSelectedPermissionId] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState("");
  const [newMemberAddress, setNewMemberAddress] = useState("");
  const [newMemberLabel, setNewMemberLabel] = useState("");
  const draft = policy.draft;
  const roles = useMemo(() => draft?.roles ?? [], [draft]);

  // Bare selectors across the selected role, resolved in one request so an
  // imported policy reads as function names rather than hex.
  const pendingSelectors = useMemo(() => {
    const role = roles.find((entry) => entry.id === selectedRoleId) ?? roles[0];
    if (!role) return [];
    return role.permissions
      .filter((permission) => permission.selector && !permission.signature)
      .map((permission) => permission.selector as string);
  }, [roles, selectedRoleId]);
  const selectorNames = useSelectorNames(pendingSelectors);

  // Readable, parameter-named signatures for every target in the selected role.
  // A types-only signature in the list is what makes a policy hard to review.
  const roleTargets = useMemo(() => {
    const role = roles.find((entry) => entry.id === selectedRoleId) ?? roles[0];
    if (!role) return [];
    return [
      ...new Set(
        role.permissions
          .map((permission) => permission.targetAddress.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }, [roles, selectedRoleId]);
  const functionNames = useFunctionNames(policy.scope?.chainId ?? null, roleTargets);

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) ?? roles[0] ?? null,
    [roles, selectedRoleId],
  );
  const selectedPermission = useMemo(() => {
    if (!selectedRole) return null;
    // No fallback to the first permission: with one always selected, the list
    // (and its "Add permission" button) could never be reached.
    return (
      selectedRole.permissions.find(
        (permission) => permission.id === selectedPermissionId,
      ) ?? null
    );
  }, [selectedRole, selectedPermissionId]);

  /* ---------------------------- draft mutations --------------------------- */

  const editRole = useCallback(
    (roleId: string, update: (role: DraftRole) => DraftRole) => {
      policy.setDraft((current) => ({
        ...current,
        roles: current.roles.map((role) => (role.id === roleId ? update(role) : role)),
      }));
    },
    [policy],
  );

  const editPermission = useCallback(
    (
      roleId: string,
      permissionId: string,
      update: (permission: DraftPermission) => DraftPermission,
    ) => {
      editRole(roleId, (role) => ({
        ...role,
        permissions: role.permissions.map((permission) =>
          permission.id === permissionId ? update(permission) : permission,
        ),
      }));
    },
    [editRole],
  );

  const addRole = useCallback(() => {
    const name = newRoleName.trim();
    if (!name) return;
    const id = nextId("role");
    const key = suggestRoleKey(name);
    policy.setDraft((current) => ({
      ...current,
      roles: [
        ...current.roles,
        { id, key, name, description: "", members: [], permissions: [] },
      ],
    }));
    setSelectedRoleId(id);
    setSelectedPermissionId(null);
    setNewRoleName("");
    setTab("Permissions");
  }, [newRoleName, policy]);

  const removeRole = useCallback(
    (roleId: string) => {
      policy.setDraft((current) => ({
        ...current,
        roles: current.roles.filter((entry) => entry.id !== roleId),
      }));
      setSelectedRoleId(null);
      setSelectedPermissionId(null);
    },
    [policy],
  );

  const addPermission = useCallback(() => {
    if (!selectedRole) return;
    const id = nextId("permission");
    editRole(selectedRole.id, (role) => ({
      ...role,
      permissions: [
        ...role.permissions,
        {
          id,
          name: "",
          targetAddress: "",
          mode: "function",
          signature: "",
          send: false,
          delegatecall: false,
          conditions: [],
        },
      ],
    }));
    setSelectedPermissionId(id);
  }, [editRole, selectedRole]);

  const removePermission = useCallback(
    (permissionId: string) => {
      if (!selectedRole) return;
      editRole(selectedRole.id, (role) => ({
        ...role,
        permissions: role.permissions.filter(
          (permission) => permission.id !== permissionId,
        ),
      }));
      setSelectedPermissionId(null);
    },
    [editRole, selectedRole],
  );

  const addMember = useCallback(() => {
    if (!selectedRole || !isAddress(newMemberAddress)) return;
    editRole(selectedRole.id, (role) => ({
      ...role,
      members: [
        ...role.members,
        {
          id: nextId("member"),
          address: newMemberAddress,
          label: newMemberLabel.trim() || undefined,
        },
      ],
    }));
    setNewMemberAddress("");
    setNewMemberLabel("");
  }, [editRole, newMemberAddress, newMemberLabel, selectedRole]);

  const addAllowance = useCallback(() => {
    policy.setDraft((current) => ({
      ...current,
      allowances: [
        ...current.allowances,
        {
          id: nextId("allowance"),
          amountDecimals: 6,
          customInitialBalance: false,
          key: "",
          balance: "0",
          maxRefill: "0",
          refill: "0",
          period: "86400",
          // The refill window starts now, not at the epoch. With timestamp 0 the
          // modifier computes `now / period` elapsed intervals and tops the
          // balance straight up to the ceiling on first use, which would
          // contradict whatever "available now" was set to.
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      ],
    }));
    setTab("Allowances");
  }, [policy]);

  const editAllowance = useCallback(
    (allowanceId: string, update: (allowance: DraftAllowance) => DraftAllowance) => {
      policy.setDraft((current) => ({
        ...current,
        allowances: current.allowances.map((allowance) =>
          allowance.id === allowanceId ? update(allowance) : allowance,
        ),
      }));
    },
    [policy],
  );

  const resetSelection = useCallback(() => {
    setSelectedRoleId(null);
    setSelectedPermissionId(null);
    setNewRoleName("");
    setNewMemberAddress("");
    setNewMemberLabel("");
  }, []);
  return { tab, setTab, selectedRoleId, setSelectedRoleId, selectedPermissionId, setSelectedPermissionId, newRoleName, setNewRoleName, newMemberAddress, setNewMemberAddress, newMemberLabel, setNewMemberLabel, draft, roles, selectorNames, functionNames, selectedRole, selectedPermission, editRole, editPermission, addRole, removeRole, addPermission, removePermission, addMember, addAllowance, editAllowance, resetSelection };
}
