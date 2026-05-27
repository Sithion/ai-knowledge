import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpKnowledgeProvider, EnvSecretStore, ProviderManager } from '@cognistore/providers';

const secrets = new EnvSecretStore();
const sig = () => new AbortController().signal;

/** Build a mock MCP server (search tool + a resource) connected to a linked in-memory transport. */
async function mockServer() {
  const server = new McpServer({ name: 'mock', version: '1.0.0' });
  server.tool('search', { query: z.string(), limit: z.number().optional() }, async ({ query }) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ results: [{ title: 'R1', content: `mcp:${query}`, score: 0.9 }] }) }],
  }));
  server.resource('doc', 'mem://doc/1', async (uri) => ({
    contents: [{ uri: uri.href, text: 'resource body' }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

test('mcp provider: tool mode maps {results:[...]} JSON output', async () => {
  const { clientTransport } = await mockServer();
  const p = new McpKnowledgeProvider(
    { id: 'm', name: 'M', enabled: true, transport: 'stdio', mode: 'tool', toolName: 'search', argMapping: { query: 'query', k: 'limit' } },
    secrets,
    clientTransport,
  );
  try {
    const results = await p.search('hello', 5, sig());
    expect(results).toEqual([{ title: 'R1', content: 'mcp:hello', url: undefined, score: 0.9, metadata: undefined }]);
  } finally { await p.dispose(); }
});

test('mcp provider: tool mode + fanOut produces a section', async () => {
  const { clientTransport } = await mockServer();
  const p = new McpKnowledgeProvider(
    { id: 'mcp1', name: 'Docs', enabled: true, transport: 'stdio', mode: 'tool', toolName: 'search' },
    secrets,
    clientTransport,
  );
  try {
    const [section] = await new ProviderManager([p]).fanOut('q', 5, 2000);
    expect(section.providerName).toBe('Docs');
    expect(section.error).toBeUndefined();
    expect(section.results[0].content).toBe('mcp:q');
  } finally { await p.dispose(); }
});

test('mcp provider: resources mode reads resources', async () => {
  const { clientTransport } = await mockServer();
  const p = new McpKnowledgeProvider(
    { id: 'r', name: 'R', enabled: true, transport: 'stdio', mode: 'resources' },
    secrets,
    clientTransport,
  );
  try {
    const results = await p.search('anything', 5, sig());
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('resource body');
    expect(results[0].url).toContain('mem://doc/1');
  } finally { await p.dispose(); }
});

test('mcp provider: dispose closes the client (idempotent)', async () => {
  const { clientTransport } = await mockServer();
  const p = new McpKnowledgeProvider(
    { id: 'd', name: 'D', enabled: true, transport: 'stdio', mode: 'tool', toolName: 'search' },
    secrets,
    clientTransport,
  );
  await p.search('x', 1, sig());
  await p.dispose();
  await p.dispose(); // no throw
  expect(true).toBe(true);
});

test('mcp provider: dispose() called mid-connect does not leak a connected client', async () => {
  const { clientTransport } = await mockServer();
  const p = new McpKnowledgeProvider(
    { id: 'race', name: 'Race', enabled: true, transport: 'stdio', mode: 'tool', toolName: 'search' },
    secrets,
    clientTransport,
  );
  // Start a search (triggers getClient → connect), then immediately dispose.
  const searchPromise = p.search('x', 1, sig()).catch(() => {});
  await p.dispose();
  await searchPromise;
  // After dispose, further searches must throw (not silently use a leaked client).
  await expect(p.search('y', 1, sig())).rejects.toThrow(/disposed/);
});

test('mcp provider: dispose() before any connection never throws', async () => {
  const p = new McpKnowledgeProvider(
    { id: 'pre', name: 'Pre', enabled: true, transport: 'stdio', mode: 'tool', toolName: 'search' },
    secrets,
  );
  await p.dispose(); // no connection started — must not throw
  expect(true).toBe(true);
});
