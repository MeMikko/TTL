import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Abi, Hex } from 'viem';

const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', 'contracts');

/** Foundry binary from PATH or the default foundryup location, if installed. */
export function foundryBin(name: 'anvil' | 'forge'): string | undefined {
  for (const dir of (process.env.PATH ?? '')
    .split(':')
    .concat(join(homedir(), '.foundry', 'bin'))) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** Well-known anvil dev keys (public, for local chains only). */
export const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
] as const satisfies readonly Hex[];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function startAnvil(): Promise<{ rpcUrl: string; stop: () => Promise<void> }> {
  const bin = foundryBin('anvil');
  if (!bin) throw new Error('anvil not found (install Foundry)');
  const port = await freePort();
  const proc: ChildProcess = spawn(bin, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    rpcUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill();
      }),
  };
}

/** Compiles the contracts (cached by forge) and returns an artifact's ABI + bytecode. */
export function contractArtifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const forge = foundryBin('forge');
  if (!forge) throw new Error('forge not found (install Foundry)');
  execFileSync(forge, ['build', '--skip', 'test', '--skip', 'script'], {
    cwd: CONTRACTS_DIR,
    stdio: 'ignore',
  });
  const json = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, 'out', file, `${name}.json`), 'utf8'),
  ) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}
