import type { Chain } from "viem";
import { mainnet, optimism, flare, bsc, gnosis, unichain, polygon, sonic, worldchain, hyperEvm, polygonZkEvm, megaeth, mantle, base, plasma, arbitrum, celo, avalanche, ink, bob, berachain, baseSepolia, scroll, katana, sepolia } from "viem/chains";
import { supportedChainIds } from "./chains";

const known = [mainnet, optimism, flare, bsc, gnosis, unichain, polygon, sonic, worldchain, hyperEvm, polygonZkEvm, megaeth, mantle, base, plasma, arbitrum, celo, avalanche, ink, bob, berachain, baseSepolia, scroll, katana, sepolia] as const;
export const walletChains: readonly [Chain, ...Chain[]] = [mainnet, ...known.filter(chain => chain.id !== 1 && supportedChainIds.includes(chain.id))];

