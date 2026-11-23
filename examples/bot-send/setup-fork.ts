/**
 * Prepares a local anvil fork so send.ts has something real to talk to.
 *
 *   anvil --fork-url https://base-rpc.publicnode.com
 *   npx tsx examples/bot-send/setup-fork.ts
 *   SAFE_VERSION=1.5.0 MULTISEND=0xA83c336B20401Af773B6219BA5027174338D1836 npx tsx examples/bot-send/setup-fork.ts
 *
 * SAFE_VERSION is 1.3.0, 1.4.1 (default) or 1.5.0. MULTISEND is the batch
 * contract the bot will use (default MultiSendCallOnly 1.4.1).
 *
 * On the fork it deploys a fresh Safe and a Roles modifier (official mastercopy,
 * owner = avatar = target = Safe), enables the modifier, and gives a new bot key
 * one role: `approve` on TOKEN, with the spender pinned to SPENDER. It also sets
 * the MultiSend unwrapper so batches can be checked. The Safe's own calls are
 * made by impersonating it, which only works on a local fork; on a real chain
 * these steps are a Safe proposal that the owners sign (SafeRoles does this).
 *
 * Prints the environment for send.ts. Never point this at a real RPC.
 */
import { encodeDeployProxy, predictProxyAddress } from "@gnosis-guild/zodiac-core";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ExecutionOptions, Operator, ParameterType, rolesAbi } from "zodiac-roles-sdk";
import { MULTISEND_CALL_ONLY_141, roleKey } from "./roles-exec";

const RPC_URL = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
const ROLE = process.env.ROLE ?? "bot-demo";
/** Defaults are Base: WETH (the OP-stack predeploy), and the Aave v3 Pool as the spender. */
const TOKEN = getAddress(process.env.TOKEN ?? "0x4200000000000000000000000000000000000006");
const SPENDER = getAddress(process.env.SPENDER ?? "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");

/** Same addresses as app/lib/setup-roles.ts and app/lib/unwrappers.ts. */
const ROLES_MASTERCOPY: Address = "0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5";
const MULTISEND_UNWRAPPER: Address = "0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD";

/** Canonical Safe deployments (from @safe-global/safe-deployments), picked by SAFE_VERSION. */
const SAFE_DEPLOYMENTS = {
  "1.3.0": { singleton: "0x3E5c63644E683549055b9Be8653de26E0B4CD36E", factory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2" },
  "1.4.1": { singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" },
  "1.5.0": { singleton: "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e", factory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b" },
} as const satisfies Record<string, { singleton: Address; factory: Address }>;
const SAFE_VERSION = process.env.SAFE_VERSION ?? "1.4.1";
if (!(SAFE_VERSION in SAFE_DEPLOYMENTS)) throw new Error(`SAFE_VERSION must be one of ${Object.keys(SAFE_DEPLOYMENTS).join(", ")}.`);
const { singleton: SAFE_L2_SINGLETON, factory: SAFE_PROXY_FACTORY } = SAFE_DEPLOYMENTS[SAFE_VERSION as keyof typeof SAFE_DEPLOYMENTS];

/** The batch contract the bot will use; the modifier gets an unwrapper for it. */
const MULTISEND = getAddress(process.env.MULTISEND ?? MULTISEND_CALL_ONLY_141);

const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function enableModule(address module)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function VERSION() view returns (string)",
]);
const factoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

async function main() {
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `fork of ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const testClient = createTestClient({ mode: "anvil", chain, transport: http(RPC_URL) });
  const wallet = createWalletClient({ chain, transport: http(RPC_URL) });
  await testClient.getAutomine(); // fails fast if this is not anvil

  for (const [name, address] of Object.entries({ ROLES_MASTERCOPY, MULTISEND_UNWRAPPER, SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY, MULTISEND, TOKEN })) {
    if (!(await publicClient.getCode({ address }))) throw new Error(`${name} has no code on chain ${chainId}; fork a chain where it is deployed.`);
  }

  const [deployer] = await wallet.getAddresses();
  const mine = async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`setup transaction ${hash} reverted`);
  };

  // 1. A fresh 1-of-1 Safe. Its owner does not matter: the Safe is impersonated below.
  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [[deployer], 1n, `0x${"0".repeat(40)}`, "0x", `0x${"0".repeat(40)}`, `0x${"0".repeat(40)}`, 0n, `0x${"0".repeat(40)}`],
  });
  const saltNonce = BigInt(Date.now());
  const { result: safe, request } = await publicClient.simulateContract({
    account: deployer,
    address: SAFE_PROXY_FACTORY,
    abi: factoryAbi,
    functionName: "createProxyWithNonce",
    args: [SAFE_L2_SINGLETON, initializer, saltNonce],
  });
  await mine(await wallet.writeContract(request));

  // 2. The Roles modifier, owned by the Safe and acting on it.
  const setupArgs = { types: ["address", "address", "address"], values: [safe, safe, safe] };
  const rolesMod = getAddress(predictProxyAddress({ mastercopy: ROLES_MASTERCOPY, setupArgs, saltNonce: saltNonce.toString() }));
  const deployment = encodeDeployProxy({ mastercopy: ROLES_MASTERCOPY, setupArgs, saltNonce: saltNonce.toString() });
  await mine(await wallet.sendTransaction({ account: deployer, to: getAddress(String(deployment.to)), data: String(deployment.data) as Hex }));

  // 3. Everything owner-only, sent as the Safe itself.
  await testClient.impersonateAccount({ address: safe });
  await testClient.setBalance({ address: safe, value: parseEther("1") });
  const asSafe = async (to: Address, data: Hex) => mine(await wallet.sendTransaction({ account: safe, to, data }));

  const key = roleKey(ROLE);
  // A throwaway key that exists only on this fork.
  const botKey = generatePrivateKey();
  const bot = privateKeyToAccount(botKey);
  const approveSelector = toFunctionSelector("approve(address,uint256)");
  const roles = (functionName: string, args: readonly unknown[]) =>
    encodeFunctionData({ abi: rolesAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);

  await asSafe(safe, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [rolesMod] }));
  await asSafe(rolesMod, roles("setTransactionUnwrapper", [MULTISEND, "0x8d80ff0a", MULTISEND_UNWRAPPER]));
  await asSafe(rolesMod, roles("assignRoles", [bot.address, [key], [true]]));
  await asSafe(rolesMod, roles("scopeTarget", [key, TOKEN]));
  // approve(spender, amount): spender must equal SPENDER, any amount.
  await asSafe(
    rolesMod,
    roles("scopeFunction", [
      key,
      TOKEN,
      approveSelector,
      [
        { parent: 0, paramType: ParameterType.Calldata, operator: Operator.Matches, compValue: "0x" },
        { parent: 0, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: encodeAbiParameters([{ type: "address" }], [SPENDER]) },
        { parent: 0, paramType: ParameterType.Static, operator: Operator.Pass, compValue: "0x" },
      ],
      ExecutionOptions.None,
    ]),
  );
  await testClient.stopImpersonatingAccount({ address: safe });
  await testClient.setBalance({ address: bot.address, value: parseEther("1") });

  if (!(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [rolesMod] }))) {
    throw new Error("The modifier was not enabled on the Safe.");
  }
  const symbol = await publicClient.readContract({ address: TOKEN, abi: erc20Abi, functionName: "symbol" });
  const version = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "VERSION" });

  console.log(`# Safe ${safe} (v${version}), role "${ROLE}" may approve ${symbol} to ${SPENDER} only.`);
  console.log(`export RPC_URL=${RPC_URL}`);
  console.log(`export BOT_PRIVATE_KEY=${botKey}`);
  console.log(`export ROLES_MOD=${rolesMod}`);
  console.log(`export ROLE=${ROLE}`);
  console.log(`export TOKEN=${TOKEN}`);
  console.log(`export SPENDER=${SPENDER}`);
  console.log(`export AMOUNT=1000000`);
  console.log(`export MULTISEND=${MULTISEND}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
