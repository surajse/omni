import { get as httpGet } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry, registerDocTools, ToolGateway, type AgentConfig } from '@omni/kernel';
import { createWebServer, type WebServer } from '../src/server.js';

const servers: WebServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
});

function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    httpGet(`http://127.0.0.1:${port}${path}`, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // keep raw text
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    }).on('error', reject);
  });
}

async function startServer(): Promise<{ port: number; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-web-docs-'));
  const registry = new AgentRegistry(dir);
  const config: AgentConfig = {
    id: 'scout',
    name: 'Scout',
    model: { provider: 'mock', model: 'mock' },
    systemPrompt: 'You are Scout.',
    tools: [],
    policy: [],
    memoryNamespace: 'scout',
  };
  registry.create(config);
  // Seed the docs workspace through the real doc tools.
  const gateway = new ToolGateway();
  const docsDir = join(dir, 'scout', 'docs');
  mkdirSync(docsDir, { recursive: true });
  registerDocTools(gateway, docsDir);
  await gateway.execute('doc.write', { path: 'brief.md', content: '# Brief\n\nHello **world**.' });
  await gateway.execute('doc.write', { path: 'notes/todo.md', content: '- [ ] ship it' });

  const server = createWebServer({
    registry,
    agentHome: (id) => join(dir, id),
    makeAgent: () => {
      throw new Error('not needed for docs tests');
    },
    port: 0,
  });
  const port = await server.start();
  servers.push(server);
  return { port, dir };
}

describe('docs endpoints', () => {
  it('lists documents for an agent', async () => {
    const { port } = await startServer();
    const res = await get(port, '/api/docs?agentId=scout');
    expect(res.status).toBe(200);
    expect((res.body as { files: string[] }).files.sort()).toEqual(['brief.md', 'notes/todo.md']);
  });

  it('serves document content', async () => {
    const { port } = await startServer();
    const res = await get(port, '/api/docs/content?agentId=scout&path=brief.md');
    expect(res.status).toBe(200);
    const body = res.body as { path: string; content: string };
    expect(body.path).toBe('brief.md');
    expect(body.content).toContain('Hello **world**');
  });

  it('blocks path traversal', async () => {
    const { port } = await startServer();
    const res = await get(port, '/api/docs/content?agentId=scout&path=' + encodeURIComponent('../secret'));
    expect(res.status).toBe(400);
  });

  it('404s unknown agents and missing docs', async () => {
    const { port } = await startServer();
    expect((await get(port, '/api/docs?agentId=nope')).status).toBe(404);
    expect((await get(port, '/api/docs/content?agentId=scout&path=nope.md')).status).toBe(404);
  });

  it('requires query params', async () => {
    const { port } = await startServer();
    expect((await get(port, '/api/docs')).status).toBe(400);
    expect((await get(port, '/api/docs/content?agentId=scout')).status).toBe(400);
  });

  it('serves the console page with the Docs tab', async () => {
    const { port } = await startServer();
    const res = await get(port, '/');
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('Docs');
    expect(String(res.body)).toContain('loadDocsBtn');
  });
});
