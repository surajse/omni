// Tests for the Artifacts tab endpoints: listing, HTML content serving with
// correct content-type, traversal rejection, and the sandboxed iframe.
import { get as httpGet } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry, registerArtifactTools, ToolGateway, type AgentConfig } from '@omni/kernel';
import { createWebServer, type WebServer } from '../src/server.js';

const servers: WebServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
});

function getRaw(port: number, path: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return new Promise((resolve, reject) => {
    httpGet(`http://127.0.0.1:${port}${path}`, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
          text,
        }),
      );
    }).on('error', reject);
  });
}

async function startServer(): Promise<{ port: number; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-web-artifacts-'));
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
  // Seed artifacts through the real artifact tools.
  const gateway = new ToolGateway();
  registerArtifactTools(gateway, join(dir, 'scout', 'artifacts'));
  await gateway.execute('artifact.save', { name: 'report', html: '<h1>Q3</h1>' });

  const server = createWebServer({
    registry,
    agentHome: (id) => join(dir, id),
    makeAgent: () => {
      throw new Error('not needed for artifact tests');
    },
    port: 0,
  });
  const port = await server.start();
  servers.push(server);
  return { port, dir };
}

describe('artifacts endpoints', () => {
  it('lists artifacts for an agent', async () => {
    const { port } = await startServer();
    const res = await getRaw(port, '/api/artifacts?agentId=scout');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ files: ['report.html'] });
  });

  it('serves artifact HTML with text/html content-type', async () => {
    const { port } = await startServer();
    const res = await getRaw(port, '/api/artifacts/content?agentId=scout&name=report.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toBe('<h1>Q3</h1>');
  });

  it('resolves names without the .html suffix', async () => {
    const { port } = await startServer();
    const res = await getRaw(port, '/api/artifacts/content?agentId=scout&name=report');
    expect(res.status).toBe(200);
    expect(res.text).toBe('<h1>Q3</h1>');
  });

  it('blocks path traversal', async () => {
    const { port } = await startServer();
    const res = await getRaw(port, '/api/artifacts/content?agentId=scout&name=' + encodeURIComponent('../secret'));
    expect(res.status).toBe(400);
  });

  it('404s unknown agents and missing artifacts', async () => {
    const { port } = await startServer();
    expect((await getRaw(port, '/api/artifacts?agentId=nope')).status).toBe(404);
    expect((await getRaw(port, '/api/artifacts/content?agentId=scout&name=nope.html')).status).toBe(404);
  });

  it('requires query params', async () => {
    const { port } = await startServer();
    expect((await getRaw(port, '/api/artifacts')).status).toBe(400);
    expect((await getRaw(port, '/api/artifacts/content?agentId=scout')).status).toBe(400);
  });

  it('renders the Artifacts tab with a fully-sandboxed iframe', async () => {
    const { port } = await startServer();
    const res = await getRaw(port, '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Artifacts');
    expect(res.text).toContain('loadArtifactsBtn');
    // Empty sandbox attribute = scripts, same-origin, forms all disabled.
    expect(res.text).toContain('sandbox=""');
    expect(res.text).toContain('id="artifactFrame"');
  });
});
