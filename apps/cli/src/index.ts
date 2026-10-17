#!/usr/bin/env node
// Omni CLI: init / list / chat / run / plugin validate.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  Agent,
  AgentRegistry,
  MockProvider,
  OpenAICompatibleProvider,
  PolicyEngine,
  ToolGateway,
} from '@omni/kernel';
import type { AgentConfig, ModelProvider } from '@omni/kernel';
import { SqliteMemoryStore } from '@omni/memory';
import { validateManifest } from '@omni/plugin-spec';
import { ConsoleChannel } from '@omni/channels';

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent'
  );
}

export function defaultConfig(name: string): AgentConfig {
  const id = slugify(name);
  return {
    id,
    name,
    description: `${name} — an Omni agent`,
    model: {
      provider: 'mock',
      baseUrl: process.env['OMNI_BASE_URL'],
      apiKeyEnv: 'OMNI_API_KEY',
      model: process.env['OMNI_MODEL'] ?? 'mock',
    },
    systemPrompt: `You are ${name}, a helpful AI assistant running on the Omni agent platform. Be concise, and use your tools when they help answer.`,
    tools: ['get_time', 'memory_recall', 'memory_remember'],
    policy: [],
    memoryNamespace: id,
  };
}

function omniHome(): string {
  const home = join(homedir(), '.omni');
  mkdirSync(join(home, 'agents'), { recursive: true });
  return home;
}

function buildProvider(): ModelProvider {
  const apiKey = process.env['OMNI_API_KEY'];
  if (apiKey) {
    return new OpenAICompatibleProvider({
      baseUrl: process.env['OMNI_BASE_URL'] ?? 'https://api.openai.com/v1',
      apiKey,
      model: process.env['OMNI_MODEL'] ?? 'gpt-4o-mini',
    });
  }
  return new MockProvider([]);
}

function buildGateway(home: string): { gateway: ToolGateway; memory: SqliteMemoryStore } {
  const gateway = new ToolGateway();
  const memory = new SqliteMemoryStore(join(home, 'memory.db'));

  gateway.register(
    {
      name: 'get_time',
      description: 'Get the current date and time as an ISO 8601 string.',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
    },
    () => new Date().toISOString(),
  );

  gateway.register(
    {
      name: 'memory_recall',
      description: 'Recall stored memories for a namespace.',
      parameters: {
        type: 'object',
        properties: { namespace: { type: 'string' } },
      },
      readOnly: true,
    },
    (args) => {
      const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : 'default';
      return JSON.stringify(memory.recall(namespace));
    },
  );

  gateway.register(
    {
      name: 'memory_remember',
      description: 'Store a memory under a key in a namespace.',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
      readOnly: false,
    },
    (args) => {
      const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : 'default';
      const key = typeof args['key'] === 'string' ? args['key'] : '';
      const value = typeof args['value'] === 'string' ? args['value'] : '';
      if (!key) throw new Error('memory_remember: "key" is required');
      memory.remember(namespace, key, value);
      return `remembered "${key}" in namespace "${namespace}"`;
    },
  );

  return { gateway, memory };
}

async function askApproval(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}

function usage(): string {
  return `omni — universal agent platform (v0.1)

Usage:
  omni init --name <Name>        Create a new agent (stored in ~/.omni/agents)
  omni list                      List agents
  omni chat <id>                 Interactive chat with an agent (/quit to exit)
  omni run <id> "<task>"         Run a single task and print the result
  omni plugin validate <file>    Validate an .omni-plugin.json manifest

Environment:
  OMNI_API_KEY    API key for an OpenAI-compatible endpoint (else the mock provider is used)
  OMNI_BASE_URL   Base URL for the OpenAI-compatible endpoint (default: https://api.openai.com/v1)
  OMNI_MODEL      Model name (default: gpt-4o-mini)`;
}

function cmdInit(name: string | undefined): void {
  if (!name) {
    console.error('init requires --name <Name>');
    process.exit(1);
  }
  const home = omniHome();
  const registry = new AgentRegistry(join(home, 'agents'));
  const config = registry.create(defaultConfig(name));
  console.log(`Created agent "${config.name}" (id: ${config.id}) in ${join(home, 'agents')}`);
  console.log('Next steps:');
  console.log(`  omni chat ${config.id}            # talk to it (mock provider until OMNI_API_KEY is set)`);
  console.log(`  omni run ${config.id} "what time is it?"`);
}

function cmdList(): void {
  const home = omniHome();
  const registry = new AgentRegistry(join(home, 'agents'));
  const agents = registry.list();
  if (agents.length === 0) {
    console.log('No agents yet. Create one with: omni init --name <Name>');
    return;
  }
  for (const a of agents) {
    console.log(`${a.id}\t${a.name}${a.description ? ` — ${a.description}` : ''}`);
  }
}

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('MockProvider: script exhausted')) {
    return (
      'The mock provider has no scripted replies left. ' +
      'Set OMNI_API_KEY (with OMNI_BASE_URL and OMNI_MODEL) to talk to a real model.'
    );
  }
  return message;
}

async function cmdChat(id: string): Promise<void> {
  const home = omniHome();
  const config = new AgentRegistry(join(home, 'agents')).get(id);
  const { gateway, memory } = buildGateway(home);
  try {
    const agent = new Agent(config, {
      provider: buildProvider(),
      gateway,
      policy: new PolicyEngine(config.policy),
      approve: (req) => askApproval(`Allow tool "${req.tool}" with args ${JSON.stringify(req.args)}?`),
      memory,
      onEvent: (e) => {
        if (e.type === 'tool-call') output.write(`… calling ${e.call.name}\n`);
        if (e.type === 'approval') output.write(`… ${e.call.name}: ${e.decision}\n`);
      },
    });
    const channel = new ConsoleChannel();
    channel.onMessage(async (text) => {
      try {
        const out = await agent.run(text, { maxSteps: 8 });
        return out || '(no reply)';
      } catch (err) {
        return `Error: ${friendlyError(err)}`;
      }
    });
    console.log(`Chatting with ${config.name} (${config.id}). Type /quit to exit.`);
    await channel.start();
  } finally {
    memory.close();
  }
}

async function cmdRun(id: string, task: string): Promise<void> {
  const home = omniHome();
  const config = new AgentRegistry(join(home, 'agents')).get(id);
  const { gateway, memory } = buildGateway(home);
  try {
    const agent = new Agent(config, {
      provider: buildProvider(),
      gateway,
      policy: new PolicyEngine(config.policy),
      approve: (req) => askApproval(`Allow tool "${req.tool}" with args ${JSON.stringify(req.args)}?`),
      memory,
      onEvent: (e) => {
        if (e.type === 'tool-call') console.log(`… calling ${e.call.name}`);
        if (e.type === 'approval') console.log(`… ${e.call.name}: ${e.decision}`);
      },
    });
    const result = await agent.run(task);
    console.log(result || '(no reply)');
  } catch (err) {
    console.error(`Error: ${friendlyError(err)}`);
    process.exit(1);
  } finally {
    memory.close();
  }
}

function cmdPluginValidate(file: string | undefined): void {
  if (!file) {
    console.error('plugin validate requires a <file> path');
    process.exit(1);
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    console.error(`Cannot read file: ${file}`);
    process.exit(1);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error(`Invalid JSON in ${file}`);
    process.exit(1);
  }
  const result = validateManifest(json);
  if (!result.ok) {
    console.error(`INVALID: ${file}`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK: valid plugin manifest ${result.manifest.name}@${result.manifest.version}`);
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init': {
      const nameIdx = rest.indexOf('--name');
      cmdInit(nameIdx >= 0 ? rest[nameIdx + 1] : undefined);
      break;
    }
    case 'list':
      cmdList();
      break;
    case 'chat':
      if (!rest[0]) {
        console.error('chat requires an <id>');
        process.exit(1);
      }
      await cmdChat(rest[0]);
      break;
    case 'run':
      if (!rest[0] || rest.length < 2) {
        console.error('run requires <id> and a "<task>"');
        process.exit(1);
      }
      await cmdRun(rest[0], rest.slice(1).join(' '));
      break;
    case 'plugin':
      if (rest[0] === 'validate') cmdPluginValidate(rest[1]);
      else {
        console.error('unknown plugin subcommand (try: plugin validate <file>)');
        process.exit(1);
      }
      break;
    default:
      console.log(usage());
      if (cmd && cmd !== '--help' && cmd !== '-h') process.exit(1);
      break;
  }
}

const isMain = process.argv[1]?.endsWith('index.js') === true;
if (isMain) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
