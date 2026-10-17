import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry, type AgentConfig } from '@omni/kernel';
import { SkillManager } from '@omni/skills';
import { MockRuntime } from '@omni/sandbox';
import { SqliteMemoryStore } from '@omni/memory';
import { buildSubAgentWiring } from '../src/index.js';

function configFor(id: string): AgentConfig {
  return {
    id,
    name: id,
    model: { provider: 'mock', model: 'mock' },
    systemPrompt: `You are ${id}.`,
    tools: [],
    policy: [],
    memoryNamespace: id,
  };
}

function setupHome(): { home: string; registry: AgentRegistry; memory: SqliteMemoryStore } {
  const home = mkdtempSync(join(tmpdir(), 'omni-wiring-test-'));
  const registry = new AgentRegistry(join(home, 'agents'));
  registry.create(configFor('main'));
  registry.create(configFor('helper'));
  new SkillManager(join(home, 'agents', 'helper', 'skills')).save({
    name: 'greet',
    description: 'Greet the user warmly',
    version: '1.0.0',
    steps: ['Say hello'],
    requiredTools: [],
    createdAt: new Date().toISOString(),
  });
  const memory = new SqliteMemoryStore(join(home, 'memory.db'));
  return { home, registry, memory };
}

describe('buildSubAgentWiring (handoff completion)', () => {
  it('gives sub-agents skill-prompt injection and sandbox tools', async () => {
    const { home, registry, memory } = setupHome();
    try {
      const wiring = await buildSubAgentWiring(home, memory, registry.get('helper'), {
        approve: async () => true,
        withSandbox: true,
        runtime: new MockRuntime(),
      });
      // Skill injection: the v0.3 limitation is gone.
      expect(wiring.config.systemPrompt).toContain('greet');
      expect(wiring.config.systemPrompt).toContain('Greet the user warmly');
      // Sandbox attach: identical to top-level agents.
      expect(wiring.deps.gateway.has('computer.exec')).toBe(true);
      expect(wiring.deps.gateway.has('computer.read_file')).toBe(true);
      expect(wiring.deps.gateway.has('computer.write_file')).toBe(true);
      // Standard tools still present.
      expect(wiring.deps.gateway.has('get_time')).toBe(true);
    } finally {
      memory.close();
    }
  });

  it('skips sandbox tools when withSandbox is false (skills still injected)', async () => {
    const { home, registry, memory } = setupHome();
    try {
      const wiring = await buildSubAgentWiring(home, memory, registry.get('helper'), {
        approve: async () => true,
        withSandbox: false,
      });
      expect(wiring.config.systemPrompt).toContain('greet');
      expect(wiring.deps.gateway.has('computer.exec')).toBe(false);
      expect(wiring.deps.gateway.has('get_time')).toBe(true);
    } finally {
      memory.close();
    }
  });

  it('wires a RoutingProvider when the config carries providers', async () => {
    const { home, registry, memory } = setupHome();
    try {
      const cfg = configFor('routed');
      cfg.providers = [
        { id: 'a', baseUrl: 'https://a.example/v1', apiKey: 'k', models: ['m1'] },
        { id: 'b', baseUrl: 'https://b.example/v1', apiKey: 'k', models: ['m2'] },
      ];
      cfg.routing = [{ match: '^code-', providerId: 'b' }];
      registry.create(cfg);
      const wiring = await buildSubAgentWiring(home, memory, registry.get('routed'), {
        approve: async () => true,
        withSandbox: false,
      });
      expect(wiring.deps.provider.name).toBe('routing');
    } finally {
      memory.close();
    }
  });

  it('leaves browser tools off when OMNI_BROWSER_CDP_URL is unset', async () => {
    const saved = process.env['OMNI_BROWSER_CDP_URL'];
    delete process.env['OMNI_BROWSER_CDP_URL'];
    const { home, registry, memory } = setupHome();
    try {
      const wiring = await buildSubAgentWiring(home, memory, registry.get('helper'), {
        approve: async () => true,
        withSandbox: false,
      });
      expect(wiring.deps.gateway.has('browser.open')).toBe(false);
      expect(wiring.deps.gateway.has('browser.snapshot')).toBe(false);
    } finally {
      if (saved !== undefined) process.env['OMNI_BROWSER_CDP_URL'] = saved;
      memory.close();
    }
  });
});
