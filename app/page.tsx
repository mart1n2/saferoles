"use client";

import { useMemo, useState } from "react";
import { isAddress } from "ethers";
import { buildRolesTransactions } from "./lib/roles-transactions";

type MemberKind = "EOA" | "Safe" | "Bot";
type PermissionMode = "Function" | "Target";
type Risk = "Low" | "Medium" | "High" | "Critical";

type Member = {
  id: string;
  name: string;
  address: string;
  kind: MemberKind;
};

type Condition = {
  id: string;
  index: number;
  parameter: string;
  operator: "Equal to" | "Equal to avatar" | "Within allowance" | "Pass";
  value: string;
};

type Permission = {
  id: string;
  contract: string;
  address: string;
  signature: string;
  mode: PermissionMode;
  execution: "Call" | "Delegate call";
  conditions: Condition[];
  allowance?: {
    key: string;
    amount: string;
    period: string;
    display?: string;
    periodLabel?: string;
  };
};

type Role = {
  id: string;
  name: string;
  key: string;
  description: string;
  members: Member[];
  permissions: Permission[];
};

type Change = {
  id: string;
  action: "Added" | "Updated" | "Removed";
  subject: string;
  detail: string;
  risk: Risk;
};

const originalRoles: Role[] = [
  {
    id: "treasury-operator",
    name: "Treasury Operator",
    key: "treasury_operator",
    description:
      "Routine treasury operations with recipient constraints and bounded daily spend.",
    members: [
      {
        id: "m1",
        name: "Treasury Bot",
        address: "0x71C7…4D8F",
        kind: "Bot",
      },
      {
        id: "m2",
        name: "Finance Safe",
        address: "0x849D…25A2",
        kind: "Safe",
      },
    ],
    permissions: [
      {
        id: "p1",
        contract: "USDC",
        address: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        signature: "transfer(address,uint256)",
        mode: "Function",
        execution: "Call",
        conditions: [
          {
            id: "c1",
            index: 0,
            parameter: "to",
            operator: "Equal to",
            value: "0x5B4E…62F8 · Operations Safe",
          },
          {
            id: "c2",
            index: 1,
            parameter: "amount",
            operator: "Within allowance",
            value: "daily_usdc",
          },
        ],
        allowance: {
          key: "daily_usdc",
          amount: "50000000000",
          period: "86400",
          display: "50,000 USDC",
          periodLabel: "24 hours",
        },
      },
      {
        id: "p2",
        contract: "Aave V3 Pool",
        address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
        signature: "supply(address,uint256,address,uint16)",
        mode: "Function",
        execution: "Call",
        conditions: [
          {
            id: "c3",
            index: 0,
            parameter: "asset",
            operator: "Equal to",
            value: "USDC · 0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          },
          {
            id: "c4",
            index: 2,
            parameter: "onBehalfOf",
            operator: "Equal to avatar",
            value: "Treasury Safe",
          },
        ],
      },
      {
        id: "p3",
        contract: "WETH",
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        signature: "deposit()",
        mode: "Function",
        execution: "Call",
        conditions: [],
      },
    ],
  },
  {
    id: "revenue-sweeper",
    name: "Revenue Sweeper",
    key: "revenue_sweeper",
    description:
      "Collect protocol revenue and return assets to the treasury avatar.",
    members: [
      {
        id: "m3",
        name: "Sweep Automation",
        address: "0xB12A…1C09",
        kind: "Bot",
      },
    ],
    permissions: [
      {
        id: "p4",
        contract: "Revenue Router",
        address: "0x092F…C76A",
        signature: "sweep(address,address)",
        mode: "Function",
        execution: "Call",
        conditions: [
          {
            id: "c5",
            index: 1,
            parameter: "recipient",
            operator: "Equal to avatar",
            value: "Treasury Safe",
          },
        ],
      },
    ],
  },
  {
    id: "emergency-guardian",
    name: "Emergency Guardian",
    key: "emergency_guardian",
    description:
      "Tightening-only response role for revoking access during an incident.",
    members: [
      {
        id: "m4",
        name: "Security Council",
        address: "0xD11C…94E0",
        kind: "Safe",
      },
    ],
    permissions: [],
  },
];

const chainBaselineRoles: Role[] = originalRoles.map((role) =>
  role.id !== "treasury-operator"
    ? role
    : {
        ...role,
        permissions: role.permissions
          .filter((permission) => permission.id !== "p2")
          .map((permission) =>
            permission.id !== "p1"
              ? permission
              : {
                  ...permission,
                  allowance: permission.allowance
                    ? {
                        ...permission.allowance,
                        amount: "25000000000",
                        display: "25,000 USDC",
                      }
                    : undefined,
                },
          ),
      },
);

const seedChanges: Change[] = [
  {
    id: "d1",
    action: "Updated",
    subject: "Treasury Operator",
    detail: "daily_usdc allowance · 25,000 → 50,000 USDC",
    risk: "Medium",
  },
  {
    id: "d2",
    action: "Added",
    subject: "Treasury Operator",
    detail: "Aave V3 Pool · supply(address,uint256,address,uint16)",
    risk: "Low",
  },
];

const tabs = ["Permissions", "Members", "Allowances", "Activity"] as const;
type Tab = (typeof tabs)[number];

type WalletStatus = "disconnected" | "connecting" | "connected" | "error";

declare global {
  interface Window {
    ethereum?: {
      request(args: {
        method: string;
        params?: object | readonly unknown[];
      }): Promise<unknown>;
    };
  }
}

function riskForPermission(permission: Permission): Risk {
  if (permission.execution === "Delegate call") return "Critical";
  if (permission.mode === "Target") return "High";
  const recipientNames = ["to", "recipient", "receiver", "onBehalfOf"];
  const recipientCondition = permission.conditions.find((condition) =>
    recipientNames.includes(condition.parameter),
  );
  if (
    recipientCondition &&
    (recipientCondition.operator === "Pass" || !recipientCondition.value.trim())
  ) {
    return "High";
  }
  if (permission.allowance) return "Medium";
  return "Low";
}

function riskRank(risk: Risk) {
  return { Low: 0, Medium: 1, High: 2, Critical: 3 }[risk];
}

function shortAddress(value: string) {
  if (!value.startsWith("0x") || value.includes("…")) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export default function Home() {
  const [roles, setRoles] = useState<Role[]>(originalRoles);
  const [selectedRoleId, setSelectedRoleId] = useState(originalRoles[0].id);
  const [selectedPermissionId, setSelectedPermissionId] = useState(
    originalRoles[0].permissions[0].id,
  );
  const [tab, setTab] = useState<Tab>("Permissions");
  const [changes, setChanges] = useState<Change[]>(seedChanges);
  const [query, setQuery] = useState("");
  const [showNewRole, setShowNewRole] = useState(false);
  const [showNewMember, setShowNewMember] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberAddress, setNewMemberAddress] = useState("");
  const [safeAddress, setSafeAddress] = useState("");
  const [rolesAddress, setRolesAddress] = useState("");
  const [safeApiKey, setSafeApiKey] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [chainId, setChainId] = useState<bigint | null>(null);
  const [safeThreshold, setSafeThreshold] = useState(0);
  const [safeOwners, setSafeOwners] = useState<string[]>([]);
  const [walletStatus, setWalletStatus] =
    useState<WalletStatus>("disconnected");
  const [walletError, setWalletError] = useState("");
  const [proposalStatus, setProposalStatus] = useState<
    "idle" | "building" | "signing" | "submitting" | "submitted" | "error"
  >("idle");
  const [proposalError, setProposalError] = useState("");
  const [safeTxHash, setSafeTxHash] = useState("");

  const selectedRole =
    roles.find((role) => role.id === selectedRoleId) ?? roles[0];
  const selectedPermission =
    selectedRole.permissions.find(
      (permission) => permission.id === selectedPermissionId,
    ) ?? selectedRole.permissions[0];

  const filteredRoles = roles.filter((role) =>
    `${role.name} ${role.key}`.toLowerCase().includes(query.toLowerCase()),
  );

  const activeRisk = useMemo<Risk>(() => {
    const risks = roles.flatMap((role) =>
      role.permissions.map(riskForPermission),
    );
    return risks.sort((a, b) => riskRank(b) - riskRank(a))[0] ?? "Low";
  }, [roles]);

  const transactionPlan = useMemo(
    () =>
      buildRolesTransactions({
        rolesAddress,
        baseline: chainBaselineRoles,
        desired: roles,
      }),
    [roles, rolesAddress],
  );

  function selectRole(role: Role) {
    setSelectedRoleId(role.id);
    setSelectedPermissionId(role.permissions[0]?.id ?? "");
    setTab("Permissions");
  }

  function recordChange(change: Omit<Change, "id">) {
    setChanges((current) => [
      ...current,
      { ...change, id: `change-${Date.now()}-${current.length}` },
    ]);
  }

  function updatePermission(
    permissionId: string,
    update: (permission: Permission) => Permission,
    detail: string,
  ) {
    setRoles((current) =>
      current.map((role) =>
        role.id !== selectedRole.id
          ? role
          : {
              ...role,
              permissions: role.permissions.map((permission) =>
                permission.id === permissionId
                  ? update(permission)
                  : permission,
              ),
            },
      ),
    );
    const currentPermission = selectedRole.permissions.find(
      (permission) => permission.id === permissionId,
    );
    recordChange({
      action: "Updated",
      subject: selectedRole.name,
      detail,
      risk: currentPermission ? riskForPermission(update(currentPermission)) : "Low",
    });
  }

  function addPermission() {
    const id = `permission-${Date.now()}`;
    const permission: Permission = {
      id,
      contract: "New target",
      address: "0x",
      signature: "functionName(address,uint256)",
      mode: "Function",
      execution: "Call",
      conditions: [
        {
          id: `condition-${Date.now()}`,
          index: 0,
          parameter: "recipient",
          operator: "Equal to avatar",
          value: "Treasury Safe",
        },
      ],
    };
    setRoles((current) =>
      current.map((role) =>
        role.id === selectedRole.id
          ? { ...role, permissions: [...role.permissions, permission] }
          : role,
      ),
    );
    setSelectedPermissionId(id);
    recordChange({
      action: "Added",
      subject: selectedRole.name,
      detail: "New function permission",
      risk: "Low",
    });
  }

  function removePermission() {
    if (!selectedPermission) return;
    setRoles((current) =>
      current.map((role) =>
        role.id === selectedRole.id
          ? {
              ...role,
              permissions: role.permissions.filter(
                (permission) => permission.id !== selectedPermission.id,
              ),
            }
          : role,
      ),
    );
    const remaining = selectedRole.permissions.filter(
      (permission) => permission.id !== selectedPermission.id,
    );
    setSelectedPermissionId(remaining[0]?.id ?? "");
    recordChange({
      action: "Removed",
      subject: selectedRole.name,
      detail: `${selectedPermission.contract} · ${selectedPermission.signature}`,
      risk: "Low",
    });
  }

  function createRole() {
    const cleanName = newRoleName.trim();
    if (!cleanName) return;
    const id = `${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    const role: Role = {
      id,
      name: cleanName,
      key: cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 31),
      description: "New role. Add members and least-privilege permissions.",
      members: [],
      permissions: [],
    };
    setRoles((current) => [...current, role]);
    setSelectedRoleId(id);
    setSelectedPermissionId("");
    setNewRoleName("");
    setShowNewRole(false);
    recordChange({
      action: "Added",
      subject: cleanName,
      detail: `Role key · ${role.key}`,
      risk: "Low",
    });
  }

  function addMember() {
    if (!newMemberName.trim() || !/^0x[a-fA-F0-9]{40}$/.test(newMemberAddress)) {
      return;
    }
    const member: Member = {
      id: `member-${Date.now()}`,
      name: newMemberName.trim(),
      address: newMemberAddress,
      kind: "EOA",
    };
    setRoles((current) =>
      current.map((role) =>
        role.id === selectedRole.id
          ? { ...role, members: [...role.members, member] }
          : role,
      ),
    );
    setNewMemberName("");
    setNewMemberAddress("");
    setShowNewMember(false);
    recordChange({
      action: "Added",
      subject: selectedRole.name,
      detail: `Member · ${member.name} (${shortAddress(member.address)})`,
      risk: "Medium",
    });
  }

  function removeMember(member: Member) {
    setRoles((current) =>
      current.map((role) =>
        role.id === selectedRole.id
          ? {
              ...role,
              members: role.members.filter((item) => item.id !== member.id),
            }
          : role,
      ),
    );
    recordChange({
      action: "Removed",
      subject: selectedRole.name,
      detail: `Member · ${member.name}`,
      risk: "Low",
    });
  }

  function resetChanges() {
    setRoles(chainBaselineRoles);
    setSelectedRoleId(chainBaselineRoles[0].id);
    setSelectedPermissionId(chainBaselineRoles[0].permissions[0].id);
    setChanges([]);
  }

  function exportPolicy() {
    const payload = {
      schema: "saferoles/policy@1",
      chainId: 1,
      rolesMod: "0x182B…3453",
      generatedAt: new Date().toISOString(),
      roles,
      changes,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "treasury-roles-policy.json";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  async function connectWallet() {
    setWalletError("");
    setWalletStatus("connecting");
    try {
      if (!window.ethereum) {
        throw new Error("No injected wallet was found in this browser.");
      }
      if (!isAddress(safeAddress)) {
        throw new Error("Enter a complete Safe address.");
      }
      if (!isAddress(rolesAddress)) {
        throw new Error("Enter a complete Roles Modifier address.");
      }

      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const account = accounts[0];
      if (!account || !isAddress(account)) {
        throw new Error("The wallet did not return a valid account.");
      }
      const chainHex = (await window.ethereum.request({
        method: "eth_chainId",
      })) as string;
      const connectedChainId = BigInt(chainHex);

      const [{ default: Safe }, { BrowserProvider, Contract }] =
        await Promise.all([
          import("@safe-global/protocol-kit"),
          import("ethers"),
        ]);

      const protocolKit = await Safe.init({
        provider: window.ethereum,
        signer: account,
        safeAddress,
      });
      const [owners, threshold] = await Promise.all([
        protocolKit.getOwners(),
        protocolKit.getThreshold(),
      ]);
      if (!owners.some((owner) => owner.toLowerCase() === account.toLowerCase())) {
        throw new Error("The connected wallet is not an owner of this Safe.");
      }

      const browserProvider = new BrowserProvider(window.ethereum);
      const rolesContract = new Contract(
        rolesAddress,
        [
          "function owner() view returns (address)",
          "function avatar() view returns (address)",
        ],
        browserProvider,
      );
      const [rolesOwner, avatar] = (await Promise.all([
        rolesContract.owner(),
        rolesContract.avatar(),
      ])) as [string, string];
      if (rolesOwner.toLowerCase() !== safeAddress.toLowerCase()) {
        throw new Error(
          "This Safe is not the owner of the configured Roles Modifier.",
        );
      }
      if (avatar.toLowerCase() !== safeAddress.toLowerCase()) {
        throw new Error(
          "The configured Roles Modifier does not control this Safe avatar.",
        );
      }

      setWalletAddress(account);
      setChainId(connectedChainId);
      setSafeOwners(owners);
      setSafeThreshold(threshold);
      setWalletStatus("connected");
      setShowConnection(false);
    } catch (error) {
      setWalletStatus("error");
      setWalletError(
        error instanceof Error ? error.message : "Wallet connection failed.",
      );
    }
  }

  async function proposeToSafe() {
    setProposalError("");
    setSafeTxHash("");
    if (walletStatus !== "connected" || !window.ethereum || !chainId) {
      setShowConnection(true);
      return;
    }
    if (!safeApiKey.trim()) {
      setProposalStatus("error");
      setProposalError(
        "A Safe Transaction Service API key is required for standalone proposal submission.",
      );
      return;
    }
    if (transactionPlan.issues.length > 0) {
      setProposalStatus("error");
      setProposalError(
        "Resolve every calldata validation issue before signing.",
      );
      return;
    }
    if (transactionPlan.transactions.length === 0) {
      setProposalStatus("error");
      setProposalError("There are no encoded onchain changes to propose.");
      return;
    }
    if (activeRisk === "Critical") {
      setProposalStatus("error");
      setProposalError(
        "Critical changes are blocked. Remove delegatecall or narrow the policy.",
      );
      return;
    }

    try {
      setProposalStatus("building");
      const [{ default: Safe }, { default: SafeApiKit }] = await Promise.all([
        import("@safe-global/protocol-kit"),
        import("@safe-global/api-kit"),
      ]);
      const protocolKit = await Safe.init({
        provider: window.ethereum,
        signer: walletAddress,
        safeAddress,
      });
      const safeTransaction = await protocolKit.createTransaction({
        transactions: transactionPlan.transactions.map((transaction) => ({
          to: transaction.to,
          value: transaction.value,
          data: transaction.data,
          operation: transaction.operation,
        })),
      });
      const hash = await protocolKit.getTransactionHash(safeTransaction);
      setProposalStatus("signing");
      const signature = await protocolKit.signHash(hash);
      setProposalStatus("submitting");
      const apiKit = new SafeApiKit({
        chainId,
        apiKey: safeApiKey.trim(),
      });
      await apiKit.proposeTransaction({
        safeAddress,
        safeTransactionData: safeTransaction.data,
        safeTxHash: hash,
        senderAddress: walletAddress,
        senderSignature: signature.data,
        origin: "SafeRoles RBAC Console",
      });
      setSafeTxHash(hash);
      setProposalStatus("submitted");
    } catch (error) {
      setProposalStatus("error");
      setProposalError(
        error instanceof Error ? error.message : "Safe proposal failed.",
      );
    }
  }

  function safeAppUrl(hash: string) {
    const prefix: Record<string, string> = {
      "1": "eth",
      "100": "gno",
      "42161": "arb1",
      "8453": "base",
      "11155111": "sep",
    };
    const chainPrefix = prefix[chainId?.toString() ?? ""] ?? "eth";
    return `https://app.safe.global/transactions/tx?safe=${chainPrefix}:${safeAddress}&id=multisig_${safeAddress}_${hash}`;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="SafeRoles home">
          <span className="brand-mark" aria-hidden="true">
            SR
          </span>
          <span>SafeRoles</span>
          <span className="beta">BETA</span>
        </a>
        <button
          className="workspace-switcher"
          onClick={() => setShowConnection(true)}
        >
          <span className="network-dot" aria-hidden="true" />
          <span>
            <b>{chainId ? `Chain ${chainId.toString()}` : "Configure Safe"}</b>
            <small>
              {safeAddress
                ? `Safe · ${shortAddress(safeAddress)}`
                : "Safe and Roles Modifier addresses"}
            </small>
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
        <div className="top-actions">
          {walletStatus === "connected" ? (
            <button
              className="wallet-chip"
              onClick={() => setShowConnection(true)}
            >
              <span className="wallet-status-dot" />
              {shortAddress(walletAddress)}
              <small>
                Owner · {safeThreshold}/{safeOwners.length}
              </small>
            </button>
          ) : (
            <button
              className="button ghost"
              onClick={() => setShowConnection(true)}
            >
              Connect wallet
            </button>
          )}
          <button
            className="button primary"
            onClick={() => setShowReview(true)}
          >
            Review {changes.length} changes
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="role-sidebar">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">Workspace</span>
              <h1>Roles</h1>
            </div>
            <button
              className="icon-button"
              aria-label="Create role"
              onClick={() => setShowNewRole(true)}
            >
              +
            </button>
          </div>
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a role"
              aria-label="Find a role"
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="role-list" role="list">
            {filteredRoles.map((role) => {
              const roleRisk = role.permissions
                .map(riskForPermission)
                .sort((a, b) => riskRank(b) - riskRank(a))[0] ?? "Low";
              return (
                <button
                  key={role.id}
                  className={`role-item ${role.id === selectedRole.id ? "active" : ""}`}
                  onClick={() => selectRole(role)}
                  role="listitem"
                >
                  <span className="role-glyph" aria-hidden="true">
                    {role.name
                      .split(" ")
                      .map((word) => word[0])
                      .join("")
                      .slice(0, 2)}
                  </span>
                  <span className="role-copy">
                    <b>{role.name}</b>
                    <small>
                      {role.members.length} member
                      {role.members.length === 1 ? "" : "s"} ·{" "}
                      {role.permissions.length} permission
                      {role.permissions.length === 1 ? "" : "s"}
                    </small>
                  </span>
                  <span className={`risk-dot ${roleRisk.toLowerCase()}`} />
                </button>
              );
            })}
          </div>
          <div className="sidebar-foot">
            <span>Roles Modifier</span>
            <code>0x182B…3453</code>
            <span className="health-badge">
              {walletStatus === "connected" ? "Safe verified" : "Demo baseline"}
            </span>
          </div>
        </aside>

        <section className="role-workspace">
          <div className="breadcrumbs">
            Ethereum <span>/</span> Treasury Safe <span>/</span> Roles
          </div>
          <header className="role-header">
            <div>
              <div className="title-row">
                <h2>{selectedRole.name}</h2>
                <span className="status-badge">Active</span>
              </div>
              <p>{selectedRole.description}</p>
              <code className="role-key">role:{selectedRole.key}</code>
            </div>
            <button className="button secondary">Role settings</button>
          </header>

          <nav className="tabs" aria-label="Role sections">
            {tabs.map((item) => (
              <button
                key={item}
                className={tab === item ? "active" : ""}
                onClick={() => setTab(item)}
              >
                {item}
                {item === "Permissions" && (
                  <span>{selectedRole.permissions.length}</span>
                )}
                {item === "Members" && <span>{selectedRole.members.length}</span>}
              </button>
            ))}
          </nav>

          {tab === "Permissions" && (
            <div className="content-grid">
              <section className="content-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">Effective policy</span>
                    <h3>Permissions</h3>
                    <p>
                      Every call is denied unless it matches a permission below.
                    </p>
                  </div>
                  <button className="button secondary" onClick={addPermission}>
                    + Add permission
                  </button>
                </div>

                {selectedRole.permissions.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-mark" aria-hidden="true">
                      ∅
                    </span>
                    <h3>No permissions yet</h3>
                    <p>
                      This role cannot execute transactions until a scoped target
                      or function is added.
                    </p>
                    <button className="button primary" onClick={addPermission}>
                      Add first permission
                    </button>
                  </div>
                ) : (
                  <div className="permission-list">
                    <div className="permission-columns" aria-hidden="true">
                      <span>Target & function</span>
                      <span>Constraints</span>
                      <span>Risk</span>
                    </div>
                    {selectedRole.permissions.map((permission) => {
                      const permissionRisk = riskForPermission(permission);
                      return (
                        <button
                          key={permission.id}
                          className={`permission-row ${
                            permission.id === selectedPermission?.id
                              ? "active"
                              : ""
                          }`}
                          onClick={() => setSelectedPermissionId(permission.id)}
                        >
                          <span className="target-cell">
                            <span className="contract-mark" aria-hidden="true">
                              {permission.contract.slice(0, 2).toUpperCase()}
                            </span>
                            <span>
                              <b>{permission.contract}</b>
                              <code>{permission.signature}</code>
                              <small>{permission.address}</small>
                            </span>
                          </span>
                          <span className="constraint-cell">
                            {permission.mode === "Target" ? (
                              <span className="condition-chip dangerous">
                                All functions
                              </span>
                            ) : permission.conditions.length ? (
                              permission.conditions.slice(0, 2).map((condition) => (
                                <span className="condition-chip" key={condition.id}>
                                  {condition.parameter} · {condition.operator}
                                </span>
                              ))
                            ) : (
                              <span className="condition-chip neutral">
                                No parameters
                              </span>
                            )}
                          </span>
                          <span className={`risk-badge ${permissionRisk.toLowerCase()}`}>
                            {permissionRisk}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <aside className="inspector">
                {selectedPermission ? (
                  <>
                    <div className="inspector-heading">
                      <div>
                        <span className="eyebrow">Permission inspector</span>
                        <h3>{selectedPermission.contract}</h3>
                      </div>
                      <span
                        className={`risk-badge ${riskForPermission(
                          selectedPermission,
                        ).toLowerCase()}`}
                      >
                        {riskForPermission(selectedPermission)}
                      </span>
                    </div>

                    <div className="field-grid">
                      <label>
                        <span>Contract label</span>
                        <input
                          value={selectedPermission.contract}
                          onChange={(event) =>
                            updatePermission(
                              selectedPermission.id,
                              (permission) => ({
                                ...permission,
                                contract: event.target.value,
                              }),
                              `Renamed target to ${event.target.value || "Untitled"}`,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Target address</span>
                        <input
                          className="mono-input"
                          value={selectedPermission.address}
                          onChange={(event) =>
                            updatePermission(
                              selectedPermission.id,
                              (permission) => ({
                                ...permission,
                                address: event.target.value,
                              }),
                              "Updated target address",
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Scope</span>
                        <select
                          value={selectedPermission.mode}
                          onChange={(event) =>
                            updatePermission(
                              selectedPermission.id,
                              (permission) => ({
                                ...permission,
                                mode: event.target.value as PermissionMode,
                              }),
                              `Changed scope to ${event.target.value}`,
                            )
                          }
                        >
                          <option>Function</option>
                          <option>Target</option>
                        </select>
                      </label>
                      <label>
                        <span>Execution</span>
                        <select
                          value={selectedPermission.execution}
                          onChange={(event) =>
                            updatePermission(
                              selectedPermission.id,
                              (permission) => ({
                                ...permission,
                                execution: event.target.value as
                                  | "Call"
                                  | "Delegate call",
                              }),
                              `Changed execution to ${event.target.value}`,
                            )
                          }
                        >
                          <option>Call</option>
                          <option>Delegate call</option>
                        </select>
                      </label>
                      <label className="span-2">
                        <span>Function signature</span>
                        <input
                          className="mono-input"
                          value={selectedPermission.signature}
                          disabled={selectedPermission.mode === "Target"}
                          onChange={(event) =>
                            updatePermission(
                              selectedPermission.id,
                              (permission) => ({
                                ...permission,
                                signature: event.target.value,
                              }),
                              `Updated function · ${event.target.value}`,
                            )
                          }
                        />
                      </label>
                    </div>

                    <div className="condition-section">
                      <div className="section-label">
                        <div>
                          <b>Parameter conditions</b>
                          <span>All conditions must pass</span>
                        </div>
                        <button
                          onClick={() =>
                            updatePermission(
                              selectedPermission.id,
                              (permission) => ({
                                ...permission,
                                conditions: [
                                  ...permission.conditions,
                                  {
                                    id: `condition-${Date.now()}`,
                                    index: permission.conditions.length,
                                    parameter: "parameter",
                                    operator: "Equal to",
                                    value: "",
                                  },
                                ],
                              }),
                              "Added parameter condition",
                            )
                          }
                        >
                          + Add
                        </button>
                      </div>
                      <div className="condition-editor-list">
                        {selectedPermission.conditions.map((condition, index) => (
                          <div className="condition-editor" key={condition.id}>
                            <span className="condition-index">{index + 1}</span>
                            <div>
                              <input
                                className="condition-position"
                                type="number"
                                min="0"
                                aria-label={`Condition ${index + 1} parameter position`}
                                value={condition.index}
                                onChange={(event) =>
                                  updatePermission(
                                    selectedPermission.id,
                                    (permission) => ({
                                      ...permission,
                                      conditions: permission.conditions.map(
                                        (item) =>
                                          item.id === condition.id
                                            ? {
                                                ...item,
                                                index: Math.max(
                                                  0,
                                                  Number(event.target.value),
                                                ),
                                              }
                                            : item,
                                      ),
                                    }),
                                    `Moved ${condition.parameter} to parameter ${event.target.value}`,
                                  )
                                }
                                title="Zero-based parameter position"
                              />
                              <input
                                aria-label={`Condition ${index + 1} parameter`}
                                value={condition.parameter}
                                onChange={(event) =>
                                  updatePermission(
                                    selectedPermission.id,
                                    (permission) => ({
                                      ...permission,
                                      conditions: permission.conditions.map(
                                        (item) =>
                                          item.id === condition.id
                                            ? {
                                                ...item,
                                                parameter: event.target.value,
                                              }
                                            : item,
                                      ),
                                    }),
                                    `Updated condition parameter to ${event.target.value}`,
                                  )
                                }
                              />
                              <select
                                aria-label={`Condition ${index + 1} operator`}
                                value={condition.operator}
                                onChange={(event) =>
                                  updatePermission(
                                    selectedPermission.id,
                                    (permission) => ({
                                      ...permission,
                                      conditions: permission.conditions.map(
                                        (item) =>
                                          item.id === condition.id
                                            ? {
                                                ...item,
                                                operator: event.target.value as Condition["operator"],
                                              }
                                            : item,
                                      ),
                                    }),
                                    `Changed ${condition.parameter} operator`,
                                  )
                                }
                              >
                                <option>Equal to</option>
                                <option>Equal to avatar</option>
                                <option>Within allowance</option>
                                <option>Pass</option>
                              </select>
                              <input
                                aria-label={`Condition ${index + 1} value`}
                                value={condition.value}
                                placeholder="Comparison value"
                                onChange={(event) =>
                                  updatePermission(
                                    selectedPermission.id,
                                    (permission) => ({
                                      ...permission,
                                      conditions: permission.conditions.map(
                                        (item) =>
                                          item.id === condition.id
                                            ? { ...item, value: event.target.value }
                                            : item,
                                      ),
                                    }),
                                    `Updated ${condition.parameter} constraint`,
                                  )
                                }
                              />
                            </div>
                          </div>
                        ))}
                        {!selectedPermission.conditions.length && (
                          <p className="inline-empty">
                            This function has no parameter conditions.
                          </p>
                        )}
                      </div>
                    </div>

                    {riskForPermission(selectedPermission) !== "Low" && (
                      <div
                        className={`guardrail-callout ${riskForPermission(
                          selectedPermission,
                        ).toLowerCase()}`}
                      >
                        <b>
                          {riskForPermission(selectedPermission)}-risk change
                        </b>
                        <p>
                          {selectedPermission.execution === "Delegate call"
                            ? "Delegate call executes target code in the Safe context. This should be blocked unless explicitly approved."
                            : selectedPermission.mode === "Target"
                              ? "Target scope allows every function. Prefer selecting exact function signatures."
                              : "A recipient is unpinned or spend is controlled by an allowance. Review the blast radius before submission."}
                        </p>
                      </div>
                    )}

                    <button className="delete-link" onClick={removePermission}>
                      Remove permission
                    </button>
                  </>
                ) : (
                  <div className="inspector-empty">
                    <span>←</span>
                    <p>Select a permission to inspect its exact scope.</p>
                  </div>
                )}
              </aside>
            </div>
          )}

          {tab === "Members" && (
            <section className="single-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Role assignment</span>
                  <h3>Members</h3>
                  <p>
                    Members can execute only the permissions attached to this
                    role.
                  </p>
                </div>
                <button
                  className="button secondary"
                  onClick={() => setShowNewMember(true)}
                >
                  + Add member
                </button>
              </div>
              <div className="member-table">
                <div className="table-head">
                  <span>Member</span>
                  <span>Type</span>
                  <span>Address</span>
                  <span />
                </div>
                {selectedRole.members.map((member) => (
                  <div className="member-row" key={member.id}>
                    <span className="member-name">
                      <span className="avatar">
                        {member.name
                          .split(" ")
                          .map((word) => word[0])
                          .join("")
                          .slice(0, 2)}
                      </span>
                      <b>{member.name}</b>
                    </span>
                    <span className="type-badge">{member.kind}</span>
                    <code>{shortAddress(member.address)}</code>
                    <button onClick={() => removeMember(member)}>Remove</button>
                  </div>
                ))}
                {!selectedRole.members.length && (
                  <div className="table-empty">No members assigned.</div>
                )}
              </div>
            </section>
          )}

          {tab === "Allowances" && (
            <section className="single-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Rate limits</span>
                  <h3>Allowances</h3>
                  <p>Bound cumulative value independently of call frequency.</p>
                </div>
                <button className="button secondary">+ Add allowance</button>
              </div>
              <div className="allowance-grid">
                {selectedRole.permissions
                  .filter((permission) => permission.allowance)
                  .map((permission) => (
                    <article className="allowance-card" key={permission.id}>
                      <div>
                        <code>{permission.allowance?.key}</code>
                        <span className="status-badge">Active</span>
                      </div>
                      <strong>
                        {permission.allowance?.display ?? permission.allowance?.amount}
                      </strong>
                      <p>
                        Refills every{" "}
                        {permission.allowance?.periodLabel ??
                          `${permission.allowance?.period} seconds`}
                      </p>
                      <div className="meter">
                        <span style={{ width: "62%" }} />
                      </div>
                      <small>31,240 USDC currently available</small>
                    </article>
                  ))}
                {!selectedRole.permissions.some(
                  (permission) => permission.allowance,
                ) && (
                  <div className="empty-state compact">
                    <h3>No allowances</h3>
                    <p>Add an allowance to cap cumulative spending.</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === "Activity" && (
            <section className="single-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Audit trail</span>
                  <h3>Activity</h3>
                  <p>Local change set plus confirmed onchain configuration.</p>
                </div>
              </div>
              <div className="timeline">
                {changes
                  .filter((change) => change.subject === selectedRole.name)
                  .map((change) => (
                    <div className="timeline-item" key={change.id}>
                      <span className={`change-glyph ${change.action.toLowerCase()}`}>
                        {change.action === "Added"
                          ? "+"
                          : change.action === "Removed"
                            ? "−"
                            : "~"}
                      </span>
                      <div>
                        <b>
                          {change.action} · {change.detail}
                        </b>
                        <span>Current draft · not submitted</span>
                      </div>
                      <span className={`risk-badge ${change.risk.toLowerCase()}`}>
                        {change.risk}
                      </span>
                    </div>
                  ))}
                <div className="timeline-item">
                  <span className="change-glyph confirmed">✓</span>
                  <div>
                    <b>Demo policy baseline loaded</b>
                    <span>Local sample · replace before proposing</span>
                  </div>
                  <span className="type-badge">Sample</span>
                </div>
              </div>
            </section>
          )}
        </section>
      </div>

      {changes.length > 0 && (
        <div className="change-bar">
          <div>
            <span className="change-count">{changes.length}</span>
            <span>
              <b>Unsaved policy changes</b>
              <small>
                Highest risk:{" "}
                <span className={`risk-text ${activeRisk.toLowerCase()}`}>
                  {activeRisk}
                </span>
              </small>
            </span>
          </div>
          <div>
            <button onClick={resetChanges}>Discard</button>
            <button className="button primary" onClick={() => setShowReview(true)}>
              Review change set →
            </button>
          </div>
        </div>
      )}

      {showNewRole && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal small"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-role-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">RBAC</span>
                <h2 id="new-role-title">Create a role</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close"
                onClick={() => setShowNewRole(false)}
              >
                ×
              </button>
            </div>
            <label className="modal-field">
              <span>Role name</span>
              <input
                autoFocus
                value={newRoleName}
                onChange={(event) => setNewRoleName(event.target.value)}
                placeholder="e.g. Protocol Operator"
                onKeyDown={(event) => {
                  if (event.key === "Enter") createRole();
                }}
              />
              <small>
                Key:{" "}
                {newRoleName
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "_")
                  .slice(0, 31) || "role_key"}
              </small>
            </label>
            <div className="modal-actions">
              <button onClick={() => setShowNewRole(false)}>Cancel</button>
              <button className="button primary" onClick={createRole}>
                Create role
              </button>
            </div>
          </section>
        </div>
      )}

      {showNewMember && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal small"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-member-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">{selectedRole.name}</span>
                <h2 id="new-member-title">Add member</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close"
                onClick={() => setShowNewMember(false)}
              >
                ×
              </button>
            </div>
            <label className="modal-field">
              <span>Member label</span>
              <input
                value={newMemberName}
                onChange={(event) => setNewMemberName(event.target.value)}
                placeholder="e.g. Operations Bot"
              />
            </label>
            <label className="modal-field">
              <span>Ethereum address</span>
              <input
                className="mono-input"
                value={newMemberAddress}
                onChange={(event) => setNewMemberAddress(event.target.value)}
                placeholder="0x…"
              />
              {newMemberAddress &&
                !/^0x[a-fA-F0-9]{40}$/.test(newMemberAddress) && (
                  <small className="error-text">
                    Enter a complete 20-byte address.
                  </small>
                )}
            </label>
            <div className="modal-actions">
              <button onClick={() => setShowNewMember(false)}>Cancel</button>
              <button className="button primary" onClick={addMember}>
                Add member
              </button>
            </div>
          </section>
        </div>
      )}

      {showConnection && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal connection-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Execution boundary</span>
                <h2 id="connection-title">Connect a Safe owner</h2>
                <p>
                  SafeRoles verifies the signer, Safe, and Roles Modifier
                  relationship before it enables proposal submission.
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Close"
                onClick={() => setShowConnection(false)}
              >
                ×
              </button>
            </div>
            <div className="connection-steps">
              <div className={safeAddress ? "complete" : ""}>
                <span>1</span>
                <p>
                  <b>Safe account</b>
                  <small>Must own the Roles Modifier</small>
                </p>
              </div>
              <div className={rolesAddress ? "complete" : ""}>
                <span>2</span>
                <p>
                  <b>Roles Modifier</b>
                  <small>Must target the same Safe avatar</small>
                </p>
              </div>
              <div className={walletStatus === "connected" ? "complete" : ""}>
                <span>3</span>
                <p>
                  <b>Owner signer</b>
                  <small>Verified from the Safe owner set</small>
                </p>
              </div>
            </div>
            <div className="connection-fields">
              <label className="modal-field">
                <span>Safe address</span>
                <input
                  className="mono-input"
                  value={safeAddress}
                  onChange={(event) => {
                    setSafeAddress(event.target.value.trim());
                    setWalletStatus("disconnected");
                  }}
                  placeholder="0x…"
                />
                {safeAddress && !isAddress(safeAddress) && (
                  <small className="error-text">
                    Enter a complete 20-byte address.
                  </small>
                )}
              </label>
              <label className="modal-field">
                <span>Roles Modifier address</span>
                <input
                  className="mono-input"
                  value={rolesAddress}
                  onChange={(event) => {
                    setRolesAddress(event.target.value.trim());
                    setWalletStatus("disconnected");
                  }}
                  placeholder="0x…"
                />
                {rolesAddress && !isAddress(rolesAddress) && (
                  <small className="error-text">
                    Enter a complete 20-byte address.
                  </small>
                )}
              </label>
            </div>
            {walletError && (
              <div className="connection-error" role="alert">
                <b>Connection blocked</b>
                <p>{walletError}</p>
              </div>
            )}
            {walletStatus === "connected" && (
              <div className="connection-success">
                <span>✓</span>
                <p>
                  <b>{shortAddress(walletAddress)} is a Safe owner</b>
                  <small>
                    Threshold {safeThreshold} of {safeOwners.length} · Chain{" "}
                    {chainId?.toString()}
                  </small>
                </p>
              </div>
            )}
            <div className="modal-actions">
              <button onClick={() => setShowConnection(false)}>Cancel</button>
              <button
                className="button primary"
                onClick={connectWallet}
                disabled={walletStatus === "connecting"}
              >
                {walletStatus === "connecting"
                  ? "Checking Safe…"
                  : walletStatus === "connected"
                    ? "Reconnect wallet"
                    : "Connect and verify"}
              </button>
            </div>
          </section>
        </div>
      )}

      {showReview && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Pre-flight review</span>
                <h2 id="review-title">Review change set</h2>
                <p>
                  Generated from the desired RBAC policy. No transaction has
                  been proposed.
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Close"
                onClick={() => setShowReview(false)}
              >
                ×
              </button>
            </div>
            <div className="review-summary">
              <div>
                <span>Encoded calls</span>
                <strong>{transactionPlan.transactions.length}</strong>
              </div>
              <div>
                <span>Roles affected</span>
                <strong>{new Set(changes.map((change) => change.subject)).size}</strong>
              </div>
              <div>
                <span>Highest risk</span>
                <strong className={`risk-text ${activeRisk.toLowerCase()}`}>
                  {activeRisk}
                </strong>
              </div>
              <div>
                <span>Validation issues</span>
                <strong>{transactionPlan.issues.length}</strong>
              </div>
            </div>
            <div className="review-list">
              {changes.map((change) => (
                <div className="review-row" key={change.id}>
                  <span className={`change-glyph ${change.action.toLowerCase()}`}>
                    {change.action === "Added"
                      ? "+"
                      : change.action === "Removed"
                        ? "−"
                        : "~"}
                  </span>
                  <span>
                    <b>{change.subject}</b>
                    <small>{change.detail}</small>
                  </span>
                  <span className={`risk-badge ${change.risk.toLowerCase()}`}>
                    {change.risk}
                  </span>
                </div>
              ))}
            </div>
            <div className="integration-note">
              <span aria-hidden="true">
                {walletStatus === "connected" ? "✓" : "i"}
              </span>
              <p>
                {walletStatus === "connected"
                  ? `${shortAddress(walletAddress)} is verified as a ${safeThreshold}-of-${safeOwners.length} Safe owner. The proposal will contain ${transactionPlan.transactions.length} Roles Modifier calls.`
                  : "Connect a Safe owner to sign the Safe transaction hash and submit the proposal for threshold approval."}
              </p>
            </div>
            {transactionPlan.issues.length > 0 && (
              <div className="validation-issues" role="alert">
                <b>Calldata validation must pass</b>
                <ul>
                  {transactionPlan.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            {walletStatus === "connected" && (
              <label className="modal-field api-key-field">
                <span>Safe Transaction Service API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={safeApiKey}
                  onChange={(event) => setSafeApiKey(event.target.value)}
                  placeholder="Used only for this browser session"
                />
                <small>
                  Required by Safe API Kit v5 for the default transaction
                  service. The key is kept only in memory and is not exported
                  with the policy.
                </small>
              </label>
            )}
            {proposalError && (
              <div className="connection-error" role="alert">
                <b>Proposal not submitted</b>
                <p>{proposalError}</p>
              </div>
            )}
            {proposalStatus === "submitted" && safeTxHash && (
              <div className="proposal-success">
                <span>✓</span>
                <p>
                  <b>Proposal submitted to Safe</b>
                  <code>{safeTxHash}</code>
                </p>
                <a
                  className="button secondary"
                  href={safeAppUrl(safeTxHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View in Safe ↗
                </a>
              </div>
            )}
            <div className="modal-actions">
              <button onClick={() => setShowReview(false)}>Back to editing</button>
              <button className="button secondary" onClick={exportPolicy}>
                Export policy JSON
              </button>
              {walletStatus === "connected" ? (
                <button
                  className="button primary"
                  onClick={proposeToSafe}
                  disabled={
                    proposalStatus === "building" ||
                    proposalStatus === "signing" ||
                    proposalStatus === "submitting"
                  }
                >
                  {proposalStatus === "building"
                    ? "Building Safe transaction…"
                    : proposalStatus === "signing"
                      ? "Confirm in wallet…"
                      : proposalStatus === "submitting"
                        ? "Submitting proposal…"
                        : "Sign & propose to Safe"}
                </button>
              ) : (
                <button
                  className="button primary"
                  onClick={() => setShowConnection(true)}
                >
                  Connect Safe owner
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
