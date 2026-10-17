import { get as httpGet, request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  AgentRegistry,
  MockProvider,
  PolicyEngine,
  ToolGateway,
  type AgentConfig,
  type RunEvent,
  type ToolCall,
} from '@omni/kernel';
import { createWebServer, type WebServer } from '../src/server.js';

type Script = Array<{ text?: string; toolCalls?: ToolCall[] }>;

interface Ctx {
  server: WebServer;
  port: number;
}

const servers: WebServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
});

async function startTestServer(script: Script): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-web-test-'));
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
  const server = createWebServer({
    registry,
    agentHome: (id) => join(dir, id),
    makeAgent: (cfg, hooks) => {
      const gateway = new ToolGateway();
      gateway.register(
        {
          name: 'send_email',
          description: 'Send an email (write-class).',
          parameters: { type: 'object', properties: {} },
          readOnly: false,
        },
        async () => 'sent',
      );
      return new Agent(cfg, {
        provider: new MockProvider(script),
        gateway,
        policy: new PolicyEngine(cfg.policy),
        approve: hooks.approve,
        onEvent: hooks.onEvent,
      });
    },
    port: 0,
  });
  const port = await server.start();
  servers.push(server);
  return { server, port };
}

function api(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data));
    }
    const req = httpRequest({ port, host: '127.0.0.1', method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as unknown) : null });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function getText(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ port, host: '127.0.0.1', path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
  });
}

function collectSse(port: number, runId: string): Promise<RunEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RunEvent[] = [];
    let buf = '';
    const req = httpGet({ port, host: '127.0.0.1', path: `/api/events?runId=${runId}` }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`sse status ${res.statusCode}`));
        return;
      }
      res.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (eventLine && dataLine) {
            const ev = JSON.parse(dataLine.slice(5).trim()) as RunEvent;
            events.push(ev);
            if (ev.type === 'done') {
              req.destroy();
              resolve(events);
            }
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('web console', () => {
  it('lists agents', async () => {
    const { port } = await startTestServer([]);
    const r = await api(port, 'GET', '/api/agents');
    expect(r.status).toBe(200);
    const agents = r.json as Array<{ id: string; name: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe('scout');
  });

  it('serves the HTML console page', async () => {
    const { port } = await startTestServer([]);
    const r = await getText(port, '/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<title>Omni Console</title>');
    expect(r.text).toContain('/api/chat');
  });

  it('rejects chat for an unknown agent with 404', async () => {
    const { port } = await startTestServer([]);
    const r = await api(port, 'POST', '/api/chat', { agentId: 'nope', message: 'hi' });
    expect(r.status).toBe(404);
  });

  it('runs chat and streams a done event over SSE', async () => {
    const { port } = await startTestServer([{ text: 'hello there' }]);
    const r = await api(port, 'POST', '/api/chat', { agentId: 'scout', message: 'hi' });
    expect(r.status).toBe(200);
    const { runId } = r.json as { runId: string };
    expect(typeof runId).toBe('string');

    const events = await collectSse(port, runId);
    const done = events[events.length - 1]!;
    expect(done.type).toBe('done');
    if (done.type === 'done') expect(done.output).toBe('hello there');

    const tr = await api(port, 'GET', `/api/runs/${runId}`);
    expect(tr.status).toBe(200);
    expect((tr.json as { done: boolean }).done).toBe(true);
  });

  it('round-trips a tool approval: pending → approve → run completes', async () => {
    const { port } = await startTestServer([
      { toolCalls: [{ id: 'c1', name: 'send_email', arguments: { to: 'a@b.c' } }] },
      { text: 'sent it' },
    ]);
    const r = await api(port, 'POST', '/api/chat', { agentId: 'scout', message: 'send the mail' });
    const { runId } = r.json as { runId: string };

    const pending = await waitFor(
      () => api(port, 'GET', '/api/approvals'),
      (v) => (v.json as unknown[]).length === 1,
    );
    const list = pending.json as Array<{ id: string; tool: string }>;
    expect(list[0]!.tool).toBe('send_email');

    const decision = await api(port, 'POST', `/api/approvals/${list[0]!.id}`, { approved: true });
    expect(decision.status).toBe(200);

    const finished = await waitFor(
      () => api(port, 'GET', `/api/runs/${runId}`),
      (v) => (v.json as { done: boolean }).done,
    );
    const transcript = finished.json as { events: Array<{ event: RunEvent }> };
    const types = transcript.events.map((e) => e.event.type);
    expect(types).toContain('tool-call');
    expect(types).toContain('approval');
    const toolResult = transcript.events.find((e) => e.event.type === 'tool-result');
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.event.type === 'tool-result') {
      expect(toolResult.event.result.output).toBe('sent');
    }
    const approval = transcript.events.find((e) => e.event.type === 'approval');
    if (approval && approval.event.type === 'approval') {
      expect(approval.event.decision).toBe('approved');
    }
  });

  it('denying an approval skips the tool and finishes the run', async () => {
    const { port } = await startTestServer([
      { toolCalls: [{ id: 'c1', name: 'send_email', arguments: {} }] },
      { text: 'ok, skipped' },
    ]);
    const r = await api(port, 'POST', '/api/chat', { agentId: 'scout', message: 'send the mail' });
    const { runId } = r.json as { runId: string };

    const pending = await waitFor(
      () => api(port, 'GET', '/api/approvals'),
      (v) => (v.json as unknown[]).length === 1,
    );
    const list = pending.json as Array<{ id: string }>;
    await api(port, 'POST', `/api/approvals/${list[0]!.id}`, { approved: false });

    const finished = await waitFor(
      () => api(port, 'GET', `/api/runs/${runId}`),
      (v) => (v.json as { done: boolean }).done,
    );
    const transcript = finished.json as { events: Array<{ event: RunEvent }> };
    const approval = transcript.events.find((e) => e.event.type === 'approval');
    if (approval && approval.event.type === 'approval') {
      expect(approval.event.decision).toBe('skipped');
    }
  });

  it('returns 404 for unknown runs and approvals', async () => {
    const { port } = await startTestServer([]);
    expect((await api(port, 'GET', '/api/events?runId=nope')).status).toBe(404);
    expect((await api(port, 'GET', '/api/runs/nope')).status).toBe(404);
    expect((await api(port, 'POST', '/api/approvals/nope', { approved: true })).status).toBe(404);
  });
});
