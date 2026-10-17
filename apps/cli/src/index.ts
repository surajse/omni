#!/usr/bin/env node
// Omni CLI: init / list / chat / run / plugin validate.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomUUID } from 'node:crypto';
import {
  Agent,
  AgentRegistry,
  MockProvider,
  OpenAICompatibleProvider,
  PolicyEngine,
  RunRecorder,
  ToolGateway,
  registerHandoffTool,
} from '@omni/kernel';
import type { AgentConfig, ApprovalHandler, ModelProvider, RunEvent } from '@omni/kernel';
import { SkillManager, learnSkillFromTranscript } from '@omni/skills';
import type { Skill } from '@omni/skills';
import { createWebServer } from '@omni/web';
import { SqliteMemoryStore } from '@omni/memory';
import { validateManifest } from '@omni/plugin-spec';
import { ConsoleChannel } from '@omni/channels';
import { DockerRuntime, registerComputerTools } from '@omni/sandbox';
import { TelegramChannel } from '@omni/channels-telegram';
import { WhatsAppCloudChannel } from '@omni/channels-whatsapp';
import { RoutineStore, Scheduler, validateCron } from '@omni/scheduler';
import type { Routine } from '@omni/scheduler';

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

/** Register the standard in-process tools on a gateway (shared by CLI and web). */
function registerStandardTools(gateway: ToolGateway, memory: SqliteMemoryStore): void {
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
}

function buildGateway(home: string): { gateway: ToolGateway; memory: SqliteMemoryStore } {
  const gateway = new ToolGateway();
  const memory = new SqliteMemoryStore(join(home, 'memory.db'));
  registerStandardTools(gateway, memory);
  return { gateway, memory };
}

/** Append the agent's learned skills to its system prompt (no-op when none). */
function withSkillPrompt(config: AgentConfig, agentDir: string): AgentConfig {
  const fragment = new SkillManager(join(agentDir, 'skills')).promptFragment();
  if (!fragment) return config;
  return { ...config, systemPrompt: `${config.systemPrompt}\n\n${fragment}` };
}

function agentHomeDir(home: string, agentId: string): string {
  return join(home, 'agents', agentId);
}

function getAgentConfig(home: string, id: string): AgentConfig {
  return new AgentRegistry(join(home, 'agents')).get(id);
}

/** Agent homes that exist on disk (each may hold a routines.json). */
function eachAgentHome(home: string): string[] {
  const agentsDir = join(home, 'agents');
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(agentsDir, d.name));
  } catch {
    return [];
  }
}

function progressEvents(): (e: RunEvent) => void {
  return (e) => {
    if (e.type === 'tool-call') console.log(`… calling ${e.call.name}`);
    if (e.type === 'approval') console.log(`… ${e.call.name}: ${e.decision}`);
  };
}

interface AgentStack {
  agent: Agent;
  memory: SqliteMemoryStore;
}

/** Build an Agent with the standard tool gateway; optionally attach the Docker sandbox computer. */
async function createAgentStack(
  home: string,
  config: AgentConfig,
  opts: { approve: ApprovalHandler; onEvent?: (e: RunEvent) => void; withSandbox: boolean },
): Promise<AgentStack> {
  const { gateway, memory } = buildGateway(home);
  if (opts.withSandbox) {
    await maybeAttachSandbox(gateway, config.id);
  }
  const registry = new AgentRegistry(join(home, 'agents'));
  registerHandoffTool(gateway, {
    registry,
    makeDeps: (target) => {
      const subGateway = new ToolGateway();
      registerStandardTools(subGateway, memory);
      return {
        provider: buildProvider(),
        gateway: subGateway,
        policy: new PolicyEngine(target.policy),
        approve: opts.approve,
        memory,
        onEvent: opts.onEvent,
      };
    },
  });
  const effective = withSkillPrompt(config, agentHomeDir(home, config.id));
  const agent = new Agent(effective, {
    provider: buildProvider(),
    gateway,
    policy: new PolicyEngine(config.policy),
    approve: opts.approve,
    memory,
    onEvent: opts.onEvent,
  });
  return { agent, memory };
}

/** Best-effort: attach computer.* tools backed by Docker; warn and continue when Docker is missing. */
async function maybeAttachSandbox(gateway: ToolGateway, agentId: string): Promise<void> {
  const runtime = new DockerRuntime();
  try {
    await runtime.ensureReady();
  } catch (err) {
    console.error(
      `Sandbox unavailable (${err instanceof Error ? err.message : String(err)}) — continuing without computer tools.`,
    );
    return;
  }
  const id = await runtime.create(agentId);
  if ((await runtime.status(id)) !== 'running') await runtime.start(id);
  registerComputerTools(gateway, runtime, id);
  console.log(`Sandbox ready: container ${runtime.containerName(agentId)}`);
}

/** Parse `routine add` args; throws on bad input (pure — tested). */
export function parseRoutineAdd(rest: string[]): { agentId: string; cron: string; task: string } {
  const [agentId, cron, ...taskParts] = rest;
  if (!agentId || !cron || taskParts.length === 0) {
    throw new Error('usage: omni routine add <agent-id> "<cron>" "<task>"');
  }
  validateCron(cron);
  return { agentId, cron, task: taskParts.join(' ') };
}

/** Parse `--port N`; throws on bad input (pure — tested). */
export function parsePort(rest: string[]): number | undefined {
  const i = rest.indexOf('--port');
  if (i < 0) return undefined;
  const n = Number(rest[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be an integer 1-65535');
  return n;
}

/** Parse `--tick-ms N` (default 30s); throws on bad input (pure — tested). */
export function parseTickMs(rest: string[]): number {
  const i = rest.indexOf('--tick-ms');
  if (i < 0) return 30_000;
  const n = Number(rest[i + 1]);
  if (!Number.isInteger(n) || n < 1000) throw new Error('--tick-ms must be an integer >= 1000');
  return n;
}

/** Parse comma-separated Telegram user ids; undefined when unset/empty (pure — tested). */
export function parseIdList(csv: string | undefined): number[] | undefined {
  if (!csv) return undefined;
  const ids = csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  return ids.length > 0 ? ids : undefined;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  return `omni — universal agent platform (v0.3)

Usage:
  omni init --name <Name>                 Create a new agent (stored in ~/.omni/agents)
  omni list                               List agents
  omni chat <id>                          Interactive chat with an agent (/quit to exit)
  omni run <id> "<task>"                  Run a single task and print the result
  omni learn <id> <skill> "<description>" Learn a skill from the agent's last run
  omni web [--port N]                     Web console with live events + approval queue
  omni plugin validate <file>             Validate an .omni-plugin.json manifest
  omni routine add <id> "<cron>" "<task>" Add a scheduled routine (5-field cron)
  omni routine list [id]                  List routines
  omni routine remove <routine-id>         Remove a routine
  omni routine run [--tick-ms N]          Run the routine daemon (approvals auto-skip)
  omni telegram <id>                      Serve the agent on Telegram (needs TELEGRAM_BOT_TOKEN)
  omni whatsapp <id> [--port N]           Serve the agent on WhatsApp Cloud API
  omni sandbox exec <id> "<command>"      Run a command in the agent's Docker sandbox

Environment:
  OMNI_API_KEY            API key for an OpenAI-compatible endpoint (else the mock provider is used)
  OMNI_BASE_URL           Base URL for the OpenAI-compatible endpoint (default: https://api.openai.com/v1)
  OMNI_MODEL              Model name (default: gpt-4o-mini)
  OMNI_SANDBOX_IMAGE      Docker image for agent sandboxes (default: ubuntu:24.04)
  OMNI_WEB_PORT           Web console port (default: 8080; --port overrides)
  TELEGRAM_BOT_TOKEN      Telegram bot token from @BotFather
  TELEGRAM_ALLOWED_USERS  Comma-separated Telegram user ids allowed to chat (default: all)
  WHATSAPP_TOKEN          WhatsApp Cloud API access token
  WHATSAPP_PHONE_NUMBER_ID  WhatsApp Business phone number id
  WHATSAPP_VERIFY_TOKEN   Webhook verify token you chose in the Meta dashboard
  WHATSAPP_PORT           Webhook listen port (default: 3000)

Notes:
  - In "routine run" daemon mode there is no human to approve: write-class
    tools are auto-SKIPPED and each skip is logged. Prefer read-only routines.
  - Sandbox commands need Docker; without it the CLI warns and continues
    without computer tools.`;
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
  const recorder = new RunRecorder();
  const { agent, memory } = await createAgentStack(home, config, {
    approve: (req) => askApproval(`Allow tool "${req.tool}" with args ${JSON.stringify(req.args)}?`),
    onEvent: (e) => {
      recorder.record(e);
      if (e.type === 'tool-call') console.log(`… calling ${e.call.name}`);
      if (e.type === 'approval') console.log(`… ${e.call.name}: ${e.decision}`);
    },
    withSandbox: true,
  });
  const runId = randomUUID();
  try {
    const result = await agent.run(task);
    console.log(result || '(no reply)');
  } catch (err) {
    console.error(`Error: ${friendlyError(err)}`);
    process.exit(1);
  } finally {
    try {
      const path = recorder.save(agentHomeDir(home, id), runId);
      console.log(`Transcript saved: ${path}`);
    } catch {
      // Transcript persistence is best-effort.
    }
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

function cmdRoutineAdd(agentId: string, cron: string, task: string): void {
  const home = omniHome();
  getAgentConfig(home, agentId); // throws if the agent does not exist
  const routine = new RoutineStore(agentHomeDir(home, agentId)).add({ agentId, cron, task });
  console.log(`Added routine ${routine.id} for agent "${agentId}": ${routine.cron} — ${routine.task}`);
}

function cmdRoutineList(agentId: string | undefined): void {
  const home = omniHome();
  const homes = agentId ? [agentHomeDir(home, agentId)] : eachAgentHome(home);
  let count = 0;
  for (const dir of homes) {
    for (const r of new RoutineStore(dir).list()) {
      if (agentId && r.agentId !== agentId) continue;
      console.log(`${r.id}\t${r.agentId}\t${r.enabled ? 'on ' : 'off'}\t${r.cron}\t${r.task}`);
      count++;
    }
  }
  if (count === 0) {
    console.log('No routines. Add one with: omni routine add <agent-id> "<cron>" "<task>"');
  }
}

function cmdRoutineRemove(routineId: string): void {
  const home = omniHome();
  for (const dir of eachAgentHome(home)) {
    const store = new RoutineStore(dir);
    if (store.list().some((r) => r.id === routineId)) {
      store.remove(routineId);
      console.log(`Removed routine ${routineId}`);
      return;
    }
  }
  console.error(`routine not found: ${routineId}`);
  process.exit(1);
}

async function dispatchRoutine(home: string, routine: Routine): Promise<void> {
  const config = getAgentConfig(home, routine.agentId);
  const { agent, memory } = await createAgentStack(home, config, {
    // Daemon mode: no human to ask — auto-skip anything needing approval.
    approve: async (req) => {
      console.log(`[routine ${routine.id}] auto-skipped approval for "${req.tool}"`);
      return false;
    },
    onEvent: progressEvents(),
    withSandbox: true,
  });
  try {
    console.log(`[routine ${routine.id}] running: ${routine.task}`);
    const out = await agent.run(routine.task);
    console.log(`[routine ${routine.id}] done: ${(out || '(no reply)').slice(0, 500)}`);
  } finally {
    memory.close();
  }
}

async function cmdRoutineRun(tickMs: number): Promise<void> {
  const home = omniHome();
  const schedulers: Scheduler[] = [];
  for (const dir of eachAgentHome(home)) {
    const store = new RoutineStore(dir);
    if (store.list().length === 0) continue;
    const sched = new Scheduler(store, { tickMs });
    const dispatch = (r: Routine): Promise<void> => dispatchRoutine(home, r);
    sched.start(dispatch);
    schedulers.push(sched);
  }
  if (schedulers.length === 0) {
    console.log('No routines defined. Add one with: omni routine add <agent-id> "<cron>" "<task>"');
    return;
  }
  console.log(
    `Routine daemon started (${schedulers.length} agent(s), tick ${tickMs}ms). Ctrl+C to stop.`,
  );
  console.log('Note: in daemon mode write-class tools are auto-SKIPPED (no interactive approvals).');
  const shutdown = (): void => {
    for (const s of schedulers) s.stop();
    console.log('\nRoutine daemon stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<never>(() => {
    // run until a signal arrives
  });
}

async function cmdTelegram(id: string): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set');
    process.exit(1);
  }
  const home = omniHome();
  const config = getAgentConfig(home, id);
  const { agent, memory } = await createAgentStack(home, config, {
    approve: (req) => askApproval(`Allow tool "${req.tool}" with args ${JSON.stringify(req.args)}?`),
    onEvent: progressEvents(),
    withSandbox: true,
  });
  const channel = new TelegramChannel({
    botToken: token,
    allowedUserIds: parseIdList(process.env['TELEGRAM_ALLOWED_USERS']),
  });
  channel.onMessage(async (text) => {
    try {
      return (await agent.run(text, { maxSteps: 8 })) || '(no reply)';
    } catch (err) {
      return `Error: ${friendlyError(err)}`;
    }
  });
  console.log(`Telegram bot live for ${config.name} (${config.id}). Ctrl+C to stop.`);
  const shutdown = (): void => {
    void channel.stop().finally(() => {
      memory.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    await channel.start();
  } finally {
    memory.close();
  }
}

async function cmdWhatsapp(id: string, rest: string[]): Promise<void> {
  const phoneNumberId = process.env['WHATSAPP_PHONE_NUMBER_ID'];
  const accessToken = process.env['WHATSAPP_TOKEN'];
  const verifyToken = process.env['WHATSAPP_VERIFY_TOKEN'];
  const missing = [
    ['WHATSAPP_PHONE_NUMBER_ID', phoneNumberId],
    ['WHATSAPP_TOKEN', accessToken],
    ['WHATSAPP_VERIFY_TOKEN', verifyToken],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(`Missing environment: ${missing.join(', ')}`);
    process.exit(1);
  }
  let port: number | undefined;
  try {
    port = parsePort(rest);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const home = omniHome();
  const config = getAgentConfig(home, id);
  const { agent, memory } = await createAgentStack(home, config, {
    approve: (req) => askApproval(`Allow tool "${req.tool}" with args ${JSON.stringify(req.args)}?`),
    onEvent: progressEvents(),
    withSandbox: true,
  });
  const channel = new WhatsAppCloudChannel({
    phoneNumberId: phoneNumberId ?? '',
    accessToken: accessToken ?? '',
    verifyToken: verifyToken ?? '',
  });
  channel.onMessage(async (text) => {
    try {
      return (await agent.run(text, { maxSteps: 8 })) || '(no reply)';
    } catch (err) {
      return `Error: ${friendlyError(err)}`;
    }
  });
  const listenPort = port ?? 3000;
  await channel.start(listenPort);
  console.log(
    `WhatsApp webhook live for ${config.name} (${config.id}) on port ${listenPort}. Ctrl+C to stop.`,
  );
  console.log('Point your Meta webhook at this port (use a tunnel like cloudflared for local dev).');
  const shutdown = (): void => {
    void channel.stop().finally(() => {
      memory.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<never>(() => {
    // run until a signal arrives
  });
}

/**
 * Learn a skill from the agent's most recent recorded run transcript.
 * Exported (and tested): reads <agentDir>/runs, writes <agentDir>/skills.
 */
export function learnFromLatestRun(agentDir: string, skillName: string, description: string): Skill {
  const latest = RunRecorder.latestFile(agentDir);
  if (!latest) {
    throw new Error('no recorded runs for this agent yet — run "omni run <id> ..." first');
  }
  const recorder = new RunRecorder();
  for (const entry of RunRecorder.loadFile(latest)) recorder.record(entry.event);
  const skill = learnSkillFromTranscript(skillName, description, recorder.toolCalls(), {
    createdFrom: `run ${basename(latest, '.jsonl')}`,
  });
  new SkillManager(join(agentDir, 'skills')).save(skill);
  return skill;
}

function cmdLearn(agentId: string, skillName: string | undefined, description: string | undefined): void {
  if (!skillName || !description) {
    console.error('usage: omni learn <agent-id> <skill-name> "<description>"');
    process.exit(1);
  }
  const home = omniHome();
  getAgentConfig(home, agentId); // throws if the agent does not exist
  const dir = agentHomeDir(home, agentId);
  try {
    const skill = learnFromLatestRun(dir, skillName, description);
    console.log(
      `Learned skill "${skill.name}" v${skill.version}: ${skill.steps.length} step(s), ` +
        `tools: ${skill.requiredTools.join(', ') || 'none'}`,
    );
    console.log(`Saved: ${join(dir, 'skills', skill.name, 'SKILL.md')}`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

async function cmdWeb(portOpt: number | undefined): Promise<void> {
  const home = omniHome();
  const registry = new AgentRegistry(join(home, 'agents'));
  const envPort = Number(process.env['OMNI_WEB_PORT'] ?? '');
  const port = portOpt ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('web port must be an integer 1-65535');
    process.exit(1);
  }
  const memory = new SqliteMemoryStore(join(home, 'memory.db'));
  const server = createWebServer({
    registry,
    agentHome: (id) => agentHomeDir(home, id),
    makeAgent: (config, hooks) => {
      const gateway = new ToolGateway();
      registerStandardTools(gateway, memory);
      registerHandoffTool(gateway, {
        registry,
        makeDeps: (target) => {
          const subGateway = new ToolGateway();
          registerStandardTools(subGateway, memory);
          return {
            provider: buildProvider(),
            gateway: subGateway,
            policy: new PolicyEngine(target.policy),
            approve: hooks.approve,
            memory,
            onEvent: hooks.onEvent,
          };
        },
      });
      const effective = withSkillPrompt(config, agentHomeDir(home, config.id));
      return new Agent(effective, {
        provider: buildProvider(),
        gateway,
        policy: new PolicyEngine(config.policy),
        approve: hooks.approve,
        memory,
        onEvent: hooks.onEvent,
      });
    },
    host: '127.0.0.1',
    port,
  });
  const actualPort = await server.start();
  console.log(`Omni web console: http://127.0.0.1:${actualPort}`);
  console.log('Local-only, no auth: do not expose this port to the public internet.');
  const shutdown = (): void => {
    void server.stop().finally(() => {
      memory.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<never>(() => {
    // run until a signal arrives
  });
}

async function cmdSandboxExec(agentId: string, command: string): Promise<void> {
  const runtime = new DockerRuntime();
  try {
    await runtime.ensureReady();
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const id = await runtime.create(agentId);
  if ((await runtime.status(id)) !== 'running') await runtime.start(id);
  const res = await runtime.exec(id, ['sh', '-c', command]);
  if (res.stdout) {
    process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
  }
  if (res.stderr) {
    process.stderr.write(res.stderr.endsWith('\n') ? res.stderr : `${res.stderr}\n`);
  }
  console.error(`exit code: ${res.exitCode}`);
  if (res.exitCode !== 0) process.exit(res.exitCode);
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
    case 'learn': {
      if (!rest[0]) {
        console.error('usage: omni learn <agent-id> <skill-name> "<description>"');
        process.exit(1);
      }
      cmdLearn(rest[0], rest[1], rest.slice(2).join(' ') || undefined);
      break;
    }
    case 'web': {
      let port: number | undefined;
      try {
        port = parsePort(rest);
      } catch (err) {
        console.error(`Error: ${errText(err)}`);
        process.exit(1);
      }
      await cmdWeb(port);
      break;
    }
    case 'plugin':
      if (rest[0] === 'validate') cmdPluginValidate(rest[1]);
      else {
        console.error('unknown plugin subcommand (try: plugin validate <file>)');
        process.exit(1);
      }
      break;
    case 'routine': {
      const [sub, ...args] = rest;
      if (sub === 'add') {
        try {
          const parsed = parseRoutineAdd(args);
          cmdRoutineAdd(parsed.agentId, parsed.cron, parsed.task);
        } catch (err) {
          console.error(`Error: ${errText(err)}`);
          process.exit(1);
        }
      } else if (sub === 'list') {
        cmdRoutineList(args[0]);
      } else if (sub === 'remove') {
        if (!args[0]) {
          console.error('routine remove requires <routine-id>');
          process.exit(1);
        }
        cmdRoutineRemove(args[0]);
      } else if (sub === 'run') {
        try {
          await cmdRoutineRun(parseTickMs(args));
        } catch (err) {
          console.error(`Error: ${errText(err)}`);
          process.exit(1);
        }
      } else {
        console.error('unknown routine subcommand (try: add | list | remove | run)');
        process.exit(1);
      }
      break;
    }
    case 'telegram':
      if (!rest[0]) {
        console.error('telegram requires <agent-id>');
        process.exit(1);
      }
      await cmdTelegram(rest[0]);
      break;
    case 'whatsapp':
      if (!rest[0]) {
        console.error('whatsapp requires <agent-id>');
        process.exit(1);
      }
      await cmdWhatsapp(rest[0], rest.slice(1));
      break;
    case 'sandbox':
      if (rest[0] === 'exec') {
        if (!rest[1] || rest.length < 3) {
          console.error('sandbox exec requires <agent-id> and "<command>"');
          process.exit(1);
        }
        await cmdSandboxExec(rest[1], rest.slice(2).join(' '));
      } else {
        console.error('unknown sandbox subcommand (try: sandbox exec <agent-id> "<command>")');
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
