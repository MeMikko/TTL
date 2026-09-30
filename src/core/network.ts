import type { Config } from './config.js';

/** CAIP-2 EVM network ids this service knows about. */
export const NETWORKS = {
  'eip155:84532': { chainId: 84532, name: 'Base Sepolia', testnet: true },
  'eip155:8453': { chainId: 8453, name: 'Base', testnet: false },
  'eip155:31337': { chainId: 31337, name: 'local', testnet: true },
} as const;

export type NetworkId = keyof typeof NETWORKS;

export function chainName(network: NetworkId): string {
  return NETWORKS[network].name;
}

/**
 * The single, prominently-surfaced trust signal: is this deployment settling real money or not?
 * Driven by whether x402 is enabled and on which network, so an agent (or a human) can tell at a
 * glance from `/`, `/llms.txt`, the landing page and the dashboard whether balances are real.
 */
export type ServiceMode = 'live' | 'test' | 'disabled';

export interface NetworkInfo {
  /** 'live' = real funds on mainnet; 'test' = a testnet; 'disabled' = no x402 (free/eval only). */
  mode: ServiceMode;
  label: string;
  x402Network: NetworkId | null;
  chain: string | null;
  keeperNetwork: NetworkId | null;
}

export function networkInfo(config: Config): NetworkInfo {
  const x402Network = config.X402_ENABLED ? (config.X402_NETWORK as NetworkId) : null;
  const keeperNetwork = config.KEEPER_ENABLED
    ? (`eip155:${config.KEEPER_CHAIN_ID}` as NetworkId)
    : null;
  const mode: ServiceMode = !x402Network
    ? 'disabled'
    : NETWORKS[x402Network].testnet
      ? 'test'
      : 'live';
  const label =
    mode === 'live'
      ? 'Live — real payments on Base mainnet'
      : mode === 'test'
        ? `Testnet (${chainName(x402Network!)}) — for evaluation; balances are not real money`
        : 'Payments disabled — free / evaluation only';
  return {
    mode,
    label,
    x402Network,
    chain: x402Network ? chainName(x402Network) : null,
    keeperNetwork,
  };
}
