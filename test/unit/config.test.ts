import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, targetPolicyFromConfig } from '../../src/core/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.HEALTH_MAX_TICK_AGE_MS).toBe(120_000);
  });

  it('ignores stray whitespace and Windows line endings from .env', () => {
    const cfg = loadConfig({
      ...base,
      X402_ENABLED: 'true\r',
      X402_PAY_TO: '0x4b19ee2a3de2521a3adc901989944c209c0a60ea \r',
    });
    expect(cfg.X402_ENABLED).toBe(true);
    expect(cfg.X402_PAY_TO).toBe('0x4b19ee2a3de2521a3adc901989944c209c0a60ea');
  });

  it('coerces numeric strings', () => {
    expect(loadConfig({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a mixed testnet/mainnet deploy (x402 vs keeper chains)', () => {
    const keeper = {
      KEEPER_ENABLED: 'true',
      KEEPER_RPC_URL: 'https://mainnet.base.org',
      KEEPER_FACTORY_ADDRESS: '0x4b19ee2a3de2521a3adc901989944c209c0a60ea',
      KEEPER_PRIVATE_KEY: '0x' + '1'.repeat(64),
    };
    const x402 = {
      X402_ENABLED: 'true',
      X402_PAY_TO: '0x4b19ee2a3de2521a3adc901989944c209c0a60ea',
    };
    // x402 on mainnet, keeper on Sepolia → error.
    expect(() =>
      loadConfig({
        ...base,
        ...x402,
        X402_NETWORK: 'eip155:8453',
        ...keeper,
        KEEPER_CHAIN_ID: '84532',
      }),
    ).toThrow(/KEEPER_CHAIN_ID/);
    // Same network → fine.
    expect(
      loadConfig({
        ...base,
        ...x402,
        X402_NETWORK: 'eip155:8453',
        ...keeper,
        KEEPER_CHAIN_ID: '8453',
      }).KEEPER_CHAIN_ID,
    ).toBe(8453);
    // Local keeper chain is exempt.
    expect(() =>
      loadConfig({
        ...base,
        ...x402,
        X402_NETWORK: 'eip155:8453',
        ...keeper,
        KEEPER_CHAIN_ID: '31337',
        KEEPER_RPC_URL: 'http://127.0.0.1:8545',
      }),
    ).not.toThrow();
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadConfig({ ENCRYPTION_KEY: base.ENCRYPTION_KEY })).toThrow(ConfigError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });

  it('requires a 32-byte ENCRYPTION_KEY', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: undefined })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });

  it('refuses WEBHOOK_DEV_ALLOW_LOCAL in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', WEBHOOK_DEV_ALLOW_LOCAL: 'true' }),
    ).toThrow(/WEBHOOK_DEV_ALLOW_LOCAL/);
    expect(loadConfig({ ...base, WEBHOOK_DEV_ALLOW_LOCAL: 'true' }).WEBHOOK_DEV_ALLOW_LOCAL).toBe(
      true,
    );
  });

  it('builds a strict target policy by default', () => {
    const policy = targetPolicyFromConfig(
      loadConfig({ ...base, SERVER_PUBLIC_IPS: '1.2.3.4, 2a01::1' }),
    );
    expect(policy).toMatchObject({
      allowHttp: false,
      allowedPorts: [443, 8443],
      allowPrivate: false,
      blockedCidrs: ['1.2.3.4', '2a01::1'],
    });
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });
});
