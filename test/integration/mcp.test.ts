import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createx402MCPClient } from '@x402/mcp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { newWallet, resetDb } from '../helpers/auth.js';
import { testGateway } from '../helpers/x402.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const BASE = 'https://time2live.xyz';

function setup(opts: { payments?: boolean } = {}) {
  const app = buildApp(database, {
    config: testConfig({ PUBLIC_BASE_URL: BASE, WEBHOOK_DEV_ALLOW_LOCAL: 'true' }),
    payments: opts.payments ? testGateway().gateway : null,
  });
  // Route the MCP client's HTTP straight into the app.
  const fetchApp = (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)));
  const transport = (apiKey?: string) =>
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: fetchApp as typeof fetch,
      requestInit: apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {},
    });
  async function connect(apiKey?: string) {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(transport(apiKey));
    return client;
  }
  return { app, connect, transport };
}

const json = (r: unknown) => {
  const res = r as CallToolResult;
  const first = res.content[0];
  if (first?.type !== 'text') throw new Error('expected text content');
  return JSON.parse(first.text) as Record<string, unknown>;
};

async function registerVia(client: Client) {
  const wallet = newWallet();
  const ch = json(
    await client.callTool({ name: 'register_challenge', arguments: { address: wallet.address } }),
  );
  const signature = await wallet.signMessage({ message: ch.message as string });
  const reg = json(
    await client.callTool({ name: 'register', arguments: { message: ch.message, signature } }),
  );
  return (reg.apiKey as { key: string }).key;
}

describe('MCP server', () => {
  it('lists the tools with input schemas', async () => {
    const client = await setup().connect();
    expect(client.getServerVersion()?.name).toBe('time2live');
    expect(client.getInstructions()).toMatch(/register_challenge/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'activate',
        'buy_credits',
        'create_heartbeat',
        'create_job',
        'delete_job',
        'get_status',
        'list_jobs',
        'list_monitors',
        'ping',
        'register',
        'register_challenge',
        'trigger_job',
      ].sort(),
    );
    const createJob = tools.find((t) => t.name === 'create_job')!;
    expect(createJob.inputSchema.required).toEqual(
      expect.arrayContaining(['name', 'schedule', 'target']),
    );
    expect(tools.find((t) => t.name === 'list_jobs')!.annotations?.readOnlyHint).toBe(true);
  });

  it('registers, creates a heartbeat, pings it and reads its status', async () => {
    const { connect } = setup();
    const anon = await connect();
    const key = await registerVia(anon);
    expect(key).toMatch(/^t2l_/);

    // Unauthenticated calls explain how to authenticate.
    const denied = await anon.callTool({ name: 'get_status', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(json(denied)).toMatchObject({ error: { code: 'unauthorized' } });

    const client = await connect(key);
    const mon = json(
      await client.callTool({
        name: 'create_heartbeat',
        arguments: { name: 'agent-1', ttlSeconds: 300 },
      }),
    );
    expect(mon).toMatchObject({ status: 'new', pingUrl: `${BASE}/v1/heartbeat/${mon.id}` });

    const ping = json(await anon.callTool({ name: 'ping', arguments: { monitorId: mon.id } }));
    expect(ping).toMatchObject({ status: 'alive', previousStatus: 'new' });

    const status = json(
      await client.callTool({ name: 'get_status', arguments: { monitorId: mon.id } }),
    );
    expect(status).toMatchObject({ id: mon.id, status: 'alive' });
    const account = json(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(account).toMatchObject({ tier: { name: 'unactivated' } });
  });

  it('manages jobs; the apiKey argument works without a header', async () => {
    const { connect } = setup();
    const client = await connect();
    const apiKey = await registerVia(client);
    const job = json(
      await client.callTool({
        name: 'create_job',
        arguments: {
          apiKey,
          idempotencyKey: 'job-1',
          name: 'wake',
          schedule: { type: 'cron', expression: '*/15 * * * *' },
          target: { url: 'http://127.0.0.1:9/hook', body: { task: 'wake' } },
        },
      }),
    );
    expect(job).toMatchObject({ status: 'active', target: { body: '{"task":"wake"}' } });
    // Same idempotency key → same job.
    const again = json(
      await client.callTool({
        name: 'create_job',
        arguments: {
          apiKey,
          idempotencyKey: 'job-1',
          name: 'wake',
          schedule: { type: 'cron', expression: '*/15 * * * *' },
          target: { url: 'http://127.0.0.1:9/hook', body: { task: 'wake' } },
        },
      }),
    );
    expect(again.id).toBe(job.id);

    const list = json(await client.callTool({ name: 'list_jobs', arguments: { apiKey } }));
    expect((list.data as unknown[]).length).toBe(1);
    const run = json(
      await client.callTool({ name: 'trigger_job', arguments: { apiKey, jobId: job.id } }),
    );
    expect(run).toMatchObject({ status: 'pending', trigger: 'manual' });
    const status = await client.callTool({
      name: 'get_status',
      arguments: { apiKey, jobId: job.id },
    });
    expect((status.content as unknown[]).length).toBe(2);

    const del = await client.callTool({ name: 'delete_job', arguments: { apiKey, jobId: job.id } });
    expect(del.isError).toBeFalsy();
    const gone = await client.callTool({
      name: 'delete_job',
      arguments: { apiKey, jobId: job.id },
    });
    expect(gone.isError).toBe(true);
    expect(json(gone)).toMatchObject({ error: { code: 'not_found' } });
  });

  it('rejects invalid arguments before calling the API', async () => {
    const client = await setup().connect();
    const res = await client.callTool({ name: 'ping', arguments: { monitorId: 'nope' } });
    expect(res.isError).toBe(true);
  });

  it('pays over MCP with the x402 MCP client', async () => {
    const { connect, transport } = setup({ payments: true });
    const apiKey = await registerVia(await connect());

    const paying = createx402MCPClient({
      name: 'paying-agent',
      version: '1.0.0',
      schemes: [{ network: 'eip155:84532', client: new ExactEvmScheme(newWallet()) }],
      autoPayment: true,
    });
    await paying.connect(transport(apiKey));
    const first = await paying.callTool('create_heartbeat', { name: 'a', ttlSeconds: 60 });
    expect(first.paymentMade).toBe(false);
    // Second monitor exceeds the unactivated tier → pays the $0.10 activation, then succeeds.
    const second = await paying.callTool('create_heartbeat', { name: 'b', ttlSeconds: 60 });
    expect(second.isError).toBeFalsy();
    expect(second.paymentMade).toBe(true);
    expect(second.paymentResponse).toMatchObject({ success: true, network: 'eip155:84532' });

    const client = await connect(apiKey);
    const account = json(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(account).toMatchObject({ tier: { name: 'free' } });
  });

  it('returns 405 for GET (stateless, no SSE stream)', async () => {
    const { app } = setup();
    const res = await app.request('/mcp');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('discovery', () => {
  it('serves llms.txt, a service summary and the MCP server card', async () => {
    const { app } = setup();
    const llms = await app.request('/llms.txt');
    expect(llms.status).toBe(200);
    expect(llms.headers.get('content-type')).toMatch(/text\/markdown/);
    const text = await llms.text();
    expect(text).toMatch(/^# time2live\n\n> /);
    expect(text).toContain(`${BASE}/mcp`);
    expect(text).toContain('$0.10');

    const root = (await (await app.request('/')).json()) as Record<string, unknown>;
    expect(root).toMatchObject({ name: 'time2live', links: { mcp: `${BASE}/mcp` } });

    const card = await app.request('/.well-known/mcp/server-card.json');
    expect(card.status).toBe(200);
    const body = (await card.json()) as {
      remotes: Array<{ type: string; url: string }>;
      tools: Array<{ name: string }>;
    };
    expect(body.remotes[0]).toMatchObject({ type: 'streamable-http', url: `${BASE}/mcp` });
    expect(body.tools.map((t) => t.name)).toContain('create_heartbeat');
    const alias = await app.request('/.well-known/mcp.json');
    expect(await alias.json()).toEqual(body);
  });

  it('serves an HTML landing page to browsers, JSON to everything else', async () => {
    const { app } = setup();

    const page = await app.request('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('time2live');
    expect(html).toContain(`${BASE}/llms.txt`);
    expect(html).toContain(`${BASE}/mcp`);
    expect(html).toContain('$0.10'); // activation price rendered from config
    expect(html).not.toContain('undefined');

    // Agents and curl (no Accept, or a JSON Accept) still get the discovery JSON, unchanged.
    for (const headers of [undefined, { accept: 'application/json' }]) {
      const res = await app.request('/', headers ? { headers } : undefined);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({ name: 'time2live' });
    }
  });

  it('advertises the switch contract once the factory is configured', async () => {
    const app = buildApp(database, {
      config: testConfig({
        PUBLIC_BASE_URL: BASE,
        KEEPER_CHAIN_ID: '84532',
        KEEPER_FACTORY_ADDRESS: '0x2e877B58f992AC165143367617EBeEF93d6f1a8d',
      }),
      payments: null,
    });
    const root = (await (await app.request('/')).json()) as Record<string, unknown>;
    expect(root.deadMansSwitchContract).toEqual({
      chainId: 84532,
      factory: '0x2e877B58f992AC165143367617EBeEF93d6f1a8d',
      keeper: false,
    });
    const llms = await (await app.request('/llms.txt')).text();
    expect(llms).toContain('## On-chain dead man');
    expect(llms).toContain('0x2e877B58f992AC165143367617EBeEF93d6f1a8d');
    // Without a factory the section is absent.
    expect(await (await setup().app.request('/llms.txt')).text()).not.toContain('On-chain');
  });
});
