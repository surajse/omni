#!/usr/bin/env node
// Omni CLI: init / list / chat / run / plugin validate.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomUUID } from 'node:crypto';
import {
  Agent,
  AgentRegistry,
  GroupStore,
  MockProvider,
  OpenAICompatibleProvider,
  packAgent,
  PolicyEngine,
  registerDocTools,
  RunRecorder,
  runGroupTurn,
  ToolGateway,
  registerHandoffTool,
  unpackAgent,
} from '@omni/kernel';
import type { AgentConfig, ApprovalHandler, HandoffMade, ModelProvider, RunEvent } from '@omni/kernel';
import { SkillManager, learnSkillFromTranscript } from '@omni/skills';
import type { Skill } from '@omni/skills';
import { createWebServer } from '@omni/web';
import { SqliteMemoryStore, embed } from '@omni/memory';
import { validateManifest } from '@omni/plugin-spec';
import { ConsoleChannel } from '@omni/channels';
import { DockerRuntime, registerComputerTools } from '@omni/sandbox';
import type { ContainerRuntime } from '@omni/sandbox';
import { TelegramChannel } from '@omni/channels-telegram';
import { WhatsAppCloudChannel } from '@omni/channels-whatsapp';
import { RoutineStore, Scheduler, matchesCron, validateCron } from '@omni/scheduler';
import type { Routine } from '@omni/scheduler';
import { RegistryManager } from '@omni/registry';
import { TeamManager } from '@omni/teams';
import { PackManager, resolvePacksDir } from '@omni/packs';
import { WatchStore, checkWatch, formatWatchTarget, parseWatchTarget } from '@omni/watchers';
import type { Watch } from '@omni/watchers';

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

/** Docs directory for an agent (its document workspace). */
function agentDocsDir(home: string, agentId: string): string {
  return join(agentHomeDir(home, agentId), 'docs');
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

export interface SubAgentWiringOpts {
  approve: ApprovalHandler;
  onEvent?: (e: RunEvent) => void;
  withSandbox: boolean;
  /** Injectable for tests; defaults to DockerRuntime. */
  runtime?: ContainerRuntime;
}

/**
 * Wire a handoff sub-agent exactly like a top-level agent: standard tools,
 * skill-prompt injection, and (when withSandbox) the Docker computer tools.
 * This is the single wiring function — handoff sub-agents get identical
 * treatment to top-level agents (the v0.3 limitation is gone).
 */
export async function buildSubAgentWiring(
  home: string,
  memory: SqliteMemoryStore,
  target: AgentConfig,
  opts: SubAgentWiringOpts,
): Promise<HandoffMade> {
  const gateway = new ToolGateway();
  registerStandardTools(gateway, memory);
  registerDocTools(gateway, agentDocsDir(home, target.id));
  if (opts.withSandbox) {
    await maybeAttachSandbox(gateway, target.id, { quiet: true, runtime: opts.runtime });
  }
  const config = withSkillPrompt(target, agentHomeDir(home, target.id));
  const deps = {
    provider: buildProvider(),
    gateway,
    policy: new PolicyEngine(config.policy),
    approve: opts.approve,
    memory,
    onEvent: opts.onEvent,
  };
  return { config, deps };
}

/** Build an Agent with the standard tool gateway; optionally attach the Docker sandbox computer. */
async function createAgentStack(
  home: string,
  config: AgentConfig,
  opts: { approve: ApprovalHandler; onEvent?: (e: RunEvent) => void; withSandbox: boolean },
): Promise<AgentStack> {
  const { gateway, memory } = buildGateway(home);
  registerDocTools(gateway, agentDocsDir(home, config.id));
  if (opts.withSandbox) {
    await maybeAttachSandbox(gateway, config.id);
  }
  const registry = new AgentRegistry(join(home, 'agents'));
  registerHandoffTool(gateway, {
    registry,
    makeDeps: (target) =>
      buildSubAgentWiring(home, memory, target, {
        approve: opts.approve,
        onEvent: opts.onEvent,
        withSandbox: opts.withSandbox,
      }),
  });
  const effective = withSkillPrompt(config, agentHomeDir(home, config.id));
  const agent = new Agent(effective, {
    provider: buildProvider(),
    gateway,
    policy: new PolicyEngine(config.policy),
    approve: opts.approve,
    memory,
    onEvent: opts.onEvent,
    embedder: buildEmbedder(),
  });
  return { agent, memory };
}

/**
 * Build an embedder from env (OMNI_EMBED_MODEL + OMNI_EMBED_API_KEY).
 * Returns undefined when not configured — vector memory stays off.
 */
function buildEmbedder(): ((texts: string[]) => Promise<number[][]>) | undefined {
  const model = process.env['OMNI_EMBED_MODEL'];
  const apiKey = process.env['OMNI_EMBED_API_KEY'];
  if (!model || !apiKey) return undefined;
  const baseUrl = process.env['OMNI_EMBED_BASE_URL'] ?? 'https://api.openai.com/v1';
  return (texts: string[]) => embed(texts, { baseUrl, apiKey, model });
}

/** Best-effort: attach computer.* tools backed by Docker; warn and continue when Docker is missing. */
async function maybeAttachSandbox(
  gateway: ToolGateway,
  agentId: string,
  opts: { quiet?: boolean; runtime?: ContainerRuntime } = {},
): Promise<void> {
  const runtime = opts.runtime ?? new DockerRuntime();
  try {
    await runtime.ensureReady();
  } catch (err) {
    if (!opts.quiet) {
      console.error(
        `Sandbox unavailable (${err instanceof Error ? err.message : String(err)}) — continuing without computer tools.`,
      );
    }
    return;
  }
  const id = await runtime.create(agentId);
  if ((await runtime.status(id)) !== 'running') await runtime.start(id);
  registerComputerTools(gateway, runtime, id);
  if (!opts.quiet) {
    console.log(`Sandbox ready: container ${id}`);
  }
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

/** Parse `--out <file>`; undefined when absent (pure — tested). */
export function parseOutFile(rest: string[]): string | undefined {
  const i = rest.indexOf('--out');
  if (i < 0) return undefined;
  const file = rest[i + 1];
  if (!file) throw new Error('--out requires a file path');
  return file;
}

/** Parse `--as <id>`; undefined when absent (pure — tested). */
export function parseAsId(rest: string[]): string | undefined {
  const i = rest.indexOf('--as');
  if (i < 0) return undefined;
  const id = rest[i + 1];
  if (!id) throw new Error('--as requires an id');
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`--as id "${id}" must match ^[a-z0-9-]+$`);
  return id;
}

/** Parse `--team <name>`; throws when absent/invalid (pure — tested). */
export function parseTeamFlag(rest: string[]): string {
  const i = rest.indexOf('--team');
  const name = i >= 0 ? rest[i + 1] : undefined;
  if (!name) throw new Error('requires --team <name>');
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`--team name "${name}" must match ^[a-z0-9-]+$`);
  return name;
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
  return `omni — universal agent platform (v1.1)

Usage:
  omni init --name <Name>                 Create a new agent (stored in ~/.omni/agents)
  omni list                               List agents
  omni chat <id>                          Interactive chat with an agent (/quit to exit)
  omni run <id> "<task>"                  Run a single task and print the result
  omni learn <id> <skill> "<description>" Learn a skill from the agent's last run
  omni web [--port N]                     Web console with live events + approval queue + docs
  omni doctor                             Environment diagnostics (names of env vars only)
  omni plugin validate <file>             Validate an .omni-plugin.json manifest
  omni plugin search <query>              Search registry sources for plugins
  omni plugin install <name>              Install a plugin (~/.omni/plugins)
  omni plugin list                        List installed plugins
  omni plugin uninstall <name>            Remove an installed plugin
  omni plugin source add <n> <loc>        Add a registry source (dir or git URL)
  omni plugin source list                 List registry sources
  omni plugin source remove <n>           Remove a registry source
  omni pack list                          List specialist packs (researcher, inbox-triage, …)
  omni pack install <name> [--as <id>]    Install a specialist pack as an agent
  omni agent export <id> [--out <file>]   Export an agent as an .omnipack.json pack
  omni agent import <file> [--as <id>]    Import an agent pack
  omni team init <name>                   Create a team (shared directory)
  omni team publish <id> --team <t>       Publish an agent pack to a team
  omni team install <t> <id> [--as <n>]   Install a team agent
  omni team list                          List teams
  omni team agents <t>                    List a team's published agents
  omni group create <n> <id> <id> [...]   Create a multi-agent group chat room
  omni group list                         List group rooms
  omni group chat <name>                  Chat with a group (/quit to exit)
  omni watch add <id> <target> --every "<cron>" --task "<task>" [--cooldown <mins>]
                                          Watch a url:/file:/cmd: target for changes
  omni watch list [id]                    List watches
  omni watch remove <watch-id>            Remove a watch
  omni watch check <watch-id>             Check one watch now (prints changed/unchanged)
  omni watch run [--tick-ms N]            Run the watch daemon (approvals auto-skip)
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
  OMNI_WEB_TOKEN          Optional token guarding the web console (?token= required)
  OMNI_TEAMS_ROOT         Teams directory (default: ~/.omni/teams; point at a shared folder)
  OMNI_PACKS_DIR            Specialist packs directory (default: the repo's packs/)
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
    without computer tools.
  - Packs (.omnipack.json) scrub secrets from memory at export time; agent
    folders copy cleanly between machines.`;
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
  const channel = new TelegramChannel({
    botToken: token,
    allowedUserIds: parseIdList(process.env['TELEGRAM_ALLOWED_USERS']),
  });
  // Approvals for Telegram-originated runs arrive as inline Approve/Deny
  // buttons in the chat itself (no console access needed).
  const { agent, memory } = await createAgentStack(home, config, {
    approve: (req) => channel.requestApproval(req),
    onEvent: progressEvents(),
    withSandbox: true,
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
      registerDocTools(gateway, join(agentHomeDir(home, config.id), 'docs'));
      registerHandoffTool(gateway, {
        registry,
        makeDeps: (target) =>
          buildSubAgentWiring(home, memory, target, {
            approve: hooks.approve,
            onEvent: hooks.onEvent,
            withSandbox: true,
          }),
      });
      const effective = withSkillPrompt(config, agentHomeDir(home, config.id));
      return new Agent(effective, {
        provider: buildProvider(),
        gateway,
        policy: new PolicyEngine(config.policy),
        approve: hooks.approve,
        memory,
        onEvent: hooks.onEvent,
        embedder: buildEmbedder(),
      });
    },
    host: '127.0.0.1',
    port,
    token: process.env['OMNI_WEB_TOKEN'] || undefined,
  });
  const actualPort = await server.start();
  console.log(`Omni web console: http://127.0.0.1:${actualPort}`);
  if (process.env['OMNI_WEB_TOKEN']) {
    console.log('Token auth enabled (OMNI_WEB_TOKEN): open the URL with ?token=<value>.');
  } else {
    console.log('Local-only, no auth: do not expose this port to the public internet.');
  }
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

// ---------- plugin registry commands ----------

function cmdPluginSearch(query: string | undefined): void {
  if (!query) {
    console.error('usage: omni plugin search <query>');
    process.exit(1);
  }
  const mgr = new RegistryManager(omniHome());
  let hits;
  try {
    hits = mgr.search(query);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  if (hits.length === 0) {
    console.log(`No plugins found for "${query}".`);
    return;
  }
  for (const h of hits) {
    console.log(`${h.name}\t${h.version}\t[${h.sourceName}]${h.description ? ` — ${h.description}` : ''}`);
  }
}

function cmdPluginInstall(name: string | undefined): void {
  if (!name) {
    console.error('usage: omni plugin install <name>');
    process.exit(1);
  }
  const mgr = new RegistryManager(omniHome());
  try {
    const res = mgr.install(name);
    console.log(`Installed ${res.name}@${res.version} → ${res.installedPath}`);
    if (res.convertedFromGrok) {
      console.log('Note: converted from .grok-plugin format (manifest + skills written).');
    }
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

function cmdPluginList(): void {
  const installed = new RegistryManager(omniHome()).listInstalled();
  if (installed.length === 0) {
    console.log('No plugins installed. Search with: omni plugin search <query>');
    return;
  }
  for (const n of installed) console.log(n);
}

function cmdPluginUninstall(name: string | undefined): void {
  if (!name) {
    console.error('usage: omni plugin uninstall <name>');
    process.exit(1);
  }
  try {
    new RegistryManager(omniHome()).removeInstalled(name);
    console.log(`Uninstalled plugin "${name}".`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

function cmdPluginSourceAdd(name: string | undefined, location: string | undefined): void {
  if (!name || !location) {
    console.error('usage: omni plugin source add <name> <dir-or-git-url>');
    process.exit(1);
  }
  try {
    const rec = new RegistryManager(omniHome()).addSource(name, location);
    console.log(`Added ${rec.kind} registry source "${name}" (${rec.location}).`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

function cmdPluginSourceList(): void {
  const sources = new RegistryManager(omniHome()).listSources();
  if (sources.length === 0) {
    console.log('No registry sources. Add one with: omni plugin source add <name> <dir-or-git-url>');
    return;
  }
  for (const s of sources) console.log(`${s.name}\t${s.kind}\t${s.location}`);
}

function cmdPluginSourceRemove(name: string | undefined): void {
  if (!name) {
    console.error('usage: omni plugin source remove <name>');
    process.exit(1);
  }
  try {
    new RegistryManager(omniHome()).removeSource(name);
    console.log(`Removed registry source "${name}".`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

// ---------- agent pack commands ----------

function cmdAgentExport(id: string | undefined, rest: string[]): void {
  if (!id) {
    console.error('usage: omni agent export <id> [--out <file>]');
    process.exit(1);
  }
  let outFile: string | undefined;
  try {
    outFile = parseOutFile(rest);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const home = omniHome();
  const { memory } = buildGateway(home);
  try {
    const pack = packAgent(home, id, memory);
    const dest = outFile ?? `${id}.omnipack.json`;
    writeFileSync(dest, JSON.stringify(pack, null, 2) + '\n', 'utf8');
    console.log(
      `Exported agent "${id}" → ${dest} ` +
        `(${pack.skills.length} skill(s), ${pack.routines.length} routine(s), memory scrubbed).`,
    );
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  } finally {
    memory.close();
  }
}

function cmdAgentImport(file: string | undefined, rest: string[]): void {
  if (!file) {
    console.error('usage: omni agent import <file> [--as <new-id>]');
    process.exit(1);
  }
  let asId: string | undefined;
  try {
    asId = parseAsId(rest);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  let pack: unknown;
  try {
    pack = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.error(`Cannot read/parse pack file: ${file}`);
    process.exit(1);
  }
  const home = omniHome();
  const { memory } = buildGateway(home);
  try {
    const config = unpackAgent(home, pack, memory, asId);
    console.log(`Imported agent "${config.id}"${asId ? ` (renamed on import)` : ''}.`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  } finally {
    memory.close();
  }
}

// ---------- team commands ----------

function teamsRoot(home: string): string {
  return process.env['OMNI_TEAMS_ROOT'] ?? join(home, 'teams');
}

function cmdTeamInit(name: string | undefined): void {
  if (!name) {
    console.error('usage: omni team init <name>');
    process.exit(1);
  }
  try {
    new TeamManager(teamsRoot(omniHome())).init(name);
    console.log(`Created team "${name}". Point OMNI_TEAMS_ROOT at a shared folder to collaborate.`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

function cmdTeamPublish(agentId: string | undefined, rest: string[]): void {
  if (!agentId) {
    console.error('usage: omni team publish <agent-id> --team <name>');
    process.exit(1);
  }
  let team: string;
  try {
    team = parseTeamFlag(rest);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const home = omniHome();
  const { memory } = buildGateway(home);
  try {
    new TeamManager(teamsRoot(home)).publish(home, agentId, team, memory);
    console.log(`Published agent "${agentId}" to team "${team}".`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  } finally {
    memory.close();
  }
}

function cmdTeamInstall(team: string | undefined, agentId: string | undefined, rest: string[]): void {
  if (!team || !agentId) {
    console.error('usage: omni team install <team> <agent-id> [--as <new-id>]');
    process.exit(1);
  }
  let asId: string | undefined;
  try {
    asId = parseAsId(rest);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const home = omniHome();
  const { memory } = buildGateway(home);
  try {
    const config = new TeamManager(teamsRoot(home)).install(home, team, agentId, memory, asId);
    console.log(`Installed team agent "${agentId}" as "${config.id}".`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  } finally {
    memory.close();
  }
}

function cmdTeamList(): void {
  const teams = new TeamManager(teamsRoot(omniHome())).list();
  if (teams.length === 0) {
    console.log('No teams yet. Create one with: omni team init <name>');
    return;
  }
  for (const t of teams) console.log(t);
}

function cmdTeamAgents(team: string | undefined): void {
  if (!team) {
    console.error('usage: omni team agents <team>');
    process.exit(1);
  }
  try {
    const agents = new TeamManager(teamsRoot(omniHome())).listAgents(team);
    if (agents.length === 0) console.log(`Team "${team}" has no published agents yet.`);
    for (const a of agents) console.log(a);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

// ---------- doctor ----------

/** Parse `watch add` args; throws on bad input (pure — tested). */
export function parseWatchAdd(rest: string[]): {
  agentId: string;
  target: string;
  every: string;
  task: string;
  cooldownMinutes: number;
} {
  const [agentId, target, ...flagArgs] = rest;
  if (!agentId || !target) {
    throw new Error('usage: omni watch add <agent-id> <url:...|file:...|cmd:...> --every "<cron>" --task "<task>" [--cooldown <mins>]');
  }
  const flag = (name: string): string | undefined => {
    const i = flagArgs.indexOf(name);
    return i >= 0 ? flagArgs[i + 1] : undefined;
  };
  const every = flag('--every');
  const task = flag('--task');
  if (!every || !task) {
    throw new Error('watch add requires --every "<cron>" and --task "<task>"');
  }
  validateCron(every);
  parseWatchTarget(target); // throws on bad spec
  const cooldownRaw = flag('--cooldown');
  const cooldownMinutes = cooldownRaw === undefined ? 60 : Number(cooldownRaw);
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
    throw new Error('--cooldown must be a non-negative number of minutes');
  }
  return { agentId, target, every, task, cooldownMinutes };
}

function findWatch(home: string, watchId: string): { dir: string; watch: Watch } {
  for (const dir of eachAgentHome(home)) {
    const store = new WatchStore(dir);
    try {
      return { dir, watch: store.get(watchId) };
    } catch {
      // try the next agent home
    }
  }
  throw new Error(`watch not found: ${watchId}`);
}

function cmdWatchAdd(agentId: string, targetSpec: string, rest: string[]): void {
  let parsed;
  try {
    parsed = parseWatchAdd([agentId, targetSpec, ...rest]);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const home = omniHome();
  getAgentConfig(home, parsed.agentId); // throws if the agent does not exist
  const watch = new WatchStore(agentHomeDir(home, parsed.agentId)).add({
    agentId: parsed.agentId,
    target: parseWatchTarget(parsed.target),
    every: parsed.every,
    task: parsed.task,
    cooldownMinutes: parsed.cooldownMinutes,
  });
  console.log(
    `Added watch ${watch.id} for agent "${parsed.agentId}": ${formatWatchTarget(watch.target)} every ${watch.every}`,
  );
}

function cmdWatchList(agentId: string | undefined): void {
  const home = omniHome();
  const homes = agentId ? [agentHomeDir(home, agentId)] : eachAgentHome(home);
  let count = 0;
  for (const dir of homes) {
    for (const w of new WatchStore(dir).list()) {
      if (agentId && w.agentId !== agentId) continue;
      console.log(`${w.id}\t${w.agentId}\t${formatWatchTarget(w.target)}\t${w.every}\tcool ${w.cooldownMinutes}m`);
      count++;
    }
  }
  if (count === 0) {
    console.log('No watches. Add one with: omni watch add <agent-id> <url:...|file:...|cmd:...> --every "<cron>" --task "<task>"');
  }
}

function cmdWatchRemove(watchId: string): void {
  const home = omniHome();
  try {
    const { dir } = findWatch(home, watchId);
    new WatchStore(dir).remove(watchId);
    console.log(`Removed watch ${watchId}`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

async function cmdWatchCheck(watchId: string): Promise<void> {
  const home = omniHome();
  let found;
  try {
    found = findWatch(home, watchId);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const store = new WatchStore(found.dir);
  try {
    const res = await checkWatch(store, found.watch);
    console.log(res.changed ? 'CHANGED' : 'unchanged');
    if (res.excerpt) console.log(`excerpt: ${res.excerpt}`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

async function dispatchWatch(home: string, watch: Watch): Promise<void> {
  const store = new WatchStore(agentHomeDir(home, watch.agentId));
  let res;
  try {
    res = await checkWatch(store, watch);
  } catch (err) {
    console.error(`[watch ${watch.id}] fetch failed: ${errText(err)}`);
    return;
  }
  if (!res.changed) return;
  console.log(`[watch ${watch.id}] change detected on ${formatWatchTarget(watch.target)}`);
  const config = getAgentConfig(home, watch.agentId);
  const task = `${watch.task}\n\nObserved change (${formatWatchTarget(watch.target)}):\n${res.excerpt ?? ''}`;
  const { agent, memory } = await createAgentStack(home, config, {
    approve: async (req) => {
      console.log(`[watch ${watch.id}] auto-skipped approval for "${req.tool}"`);
      return false;
    },
    onEvent: progressEvents(),
    withSandbox: true,
  });
  try {
    const out = await agent.run(task);
    console.log(`[watch ${watch.id}] done: ${(out || '(no reply)').slice(0, 500)}`);
  } finally {
    memory.close();
  }
}

async function cmdWatchRun(tickMs: number): Promise<void> {
  const home = omniHome();
  const watches: Watch[] = [];
  for (const dir of eachAgentHome(home)) {
    for (const w of new WatchStore(dir).list()) watches.push(w);
  }
  if (watches.length === 0) {
    console.log('No watches defined. Add one with: omni watch add <agent-id> <target> --every "<cron>" --task "<task>"');
    return;
  }
  console.log(`Watch daemon started (${watches.length} watch(es), tick ${tickMs}ms). Ctrl+C to stop.`);
  console.log('Note: in daemon mode write-class tools are auto-SKIPPED (no interactive approvals).');
  const lastFired = new Map<string, string>();
  const minuteKey = (d: Date): string =>
    `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
  const tick = async (): Promise<void> => {
    const key = minuteKey(new Date());
    for (const w of watches) {
      try {
        if (!matchesCron(w.every, new Date())) continue;
      } catch {
        continue;
      }
      if (lastFired.get(w.id) === key) continue;
      lastFired.set(w.id, key);
      await dispatchWatch(home, w);
    }
  };
  const timer = setInterval(() => {
    void tick().catch((err: unknown) => console.error(`watch tick failed: ${errText(err)}`));
  }, tickMs);
  void tick();
  const shutdown = (): void => {
    clearInterval(timer);
    console.log('\nWatch daemon stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<never>(() => {
    // run until a signal arrives
  });
}

// ---------- specialist pack commands ----------

function cmdPackList(): void {
  let dir: string;
  try {
    dir = resolvePacksDir();
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const packs = new PackManager().listPacks(dir);
  if (packs.length === 0) {
    console.log('No packs found.');
    return;
  }
  for (const p of packs) {
    console.log(`${p.name}\tv${p.version} — ${p.description}`);
  }
}

function cmdPackInstall(name: string | undefined, rest: string[]): void {
  if (!name) {
    console.error('usage: omni pack install <name> [--as <id>]');
    process.exit(1);
  }
  let asId: string | undefined;
  try {
    asId = parseAsId(rest);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  let dir: string;
  try {
    dir = resolvePacksDir();
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const home = omniHome();
  try {
    const res = new PackManager().installPack(home, dir, name, asId);
    console.log(`Installed pack "${name}" as agent "${res.agentId}" (${res.skills} skill(s), ${res.routines} routine(s)).`);
    if (res.requires.length > 0) {
      console.log('Setup checklist:');
      for (const r of res.requires) console.log(`  - ${r}`);
    }
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

// ---------- group chat commands ----------

function cmdGroupCreate(name: string | undefined, members: string[]): void {
  if (!name || members.length < 2) {
    console.error('usage: omni group create <name> <agent-id> <agent-id> [more...]');
    process.exit(1);
  }
  const home = omniHome();
  const registry = new AgentRegistry(join(home, 'agents'));
  for (const id of members) {
    try {
      registry.get(id);
    } catch {
      console.error(`unknown agent: ${id}`);
      process.exit(1);
    }
  }
  try {
    new GroupStore(home).create(name, members);
    console.log(`Created group "${name}" with members: ${members.join(', ')}`);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
}

function cmdGroupList(): void {
  const groups = new GroupStore(omniHome()).list();
  if (groups.length === 0) {
    console.log('No groups yet. Create one with: omni group create <name> <agent-id> <agent-id>');
    return;
  }
  for (const g of groups) {
    console.log(`${g.name}\t${g.members.join(', ')}\t(max ${g.maxRounds} rounds)`);
  }
}

async function cmdGroupChat(name: string): Promise<void> {
  const home = omniHome();
  const store = new GroupStore(home);
  let session;
  try {
    session = store.get(name);
  } catch (err) {
    console.error(`Error: ${errText(err)}`);
    process.exit(1);
  }
  const registry = new AgentRegistry(join(home, 'agents'));
  console.log(`Group "${name}" [${session.members.join(', ')}]. Type a message; /quit to exit.`);
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const text = (await rl.question('you> ')).trim();
      if (!text) continue;
      if (text === '/quit') break;
      const { memory } = buildGateway(home);
      try {
        const turns = await runGroupTurn(
          store,
          session,
          text,
          {
            getConfig: (id) => registry.get(id),
            makeDeps: (target) =>
              buildSubAgentWiring(home, memory, target, {
                approve: (req) => askApproval(`[${target.id}] Allow tool "${req.tool}"?`),
                onEvent: (e) => {
                  if (e.type === 'tool-call') output.write(`… calling ${e.call.name}\n`);
                },
                withSandbox: true,
              }),
          },
          { maxSteps: 8 },
        );
        for (const t of turns) {
          output.write(`\n${t.member}> ${t.output || '(no reply)'}\n`);
        }
      } catch (err) {
        output.write(`Error: ${friendlyError(err)}\n`);
      } finally {
        memory.close();
      }
    }
  } finally {
    rl.close();
  }
}

// ---------- doctor ----------

function checkCommand(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Diagnostics; always exits 0. Prints names of env vars only, never values. */
function cmdDoctor(): void {
  const home = omniHome();
  const rows: Array<[string, boolean, string]> = [];
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0');
  rows.push(['node', nodeMajor >= 22, `v${process.versions.node} (needs >= 22)`]);
  rows.push(['pnpm', checkCommand('pnpm', ['--version']), checkCommand('pnpm', ['--version']) ? 'present' : 'not found on PATH']);
  let homeOk = false;
  try {
    mkdirSync(home, { recursive: true });
    const probe = join(home, '.doctor-probe');
    writeFileSync(probe, 'ok');
    rmSync(probe);
    homeOk = true;
  } catch {
    homeOk = false;
  }
  rows.push(['~/.omni writable', homeOk, homeOk ? home : 'cannot write']);
  const dockerOk = checkCommand('docker', ['--version']);
  rows.push(['docker', dockerOk, dockerOk ? 'present (sandbox available)' : 'not found — sandbox commands need it']);
  const gitOk = checkCommand('git', ['--version']);
  rows.push(['git', gitOk, gitOk ? 'present (git registry sources available)' : 'not found — git registry sources need it']);
  for (const v of ['TELEGRAM_BOT_TOKEN', 'WHATSAPP_TOKEN', 'OMNI_API_KEY', 'OMNI_WEB_TOKEN']) {
    const set = !!process.env[v];
    rows.push([v, set, set ? 'set' : 'not set']);
  }
  let sources = 0;
  try {
    sources = new RegistryManager(home).listSources().length;
  } catch {
    sources = 0;
  }
  rows.push(['registry sources', true, sources === 0 ? 'none configured' : `${sources} configured`]);
  for (const [name, ok, detail] of rows) {
    console.log(`${ok ? 'ok  ' : 'warn'} ${name}: ${detail}`);
  }
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
    case 'plugin': {
      const [sub, ...args] = rest;
      if (sub === 'validate') cmdPluginValidate(args[0]);
      else if (sub === 'search') cmdPluginSearch(args[0]);
      else if (sub === 'install') cmdPluginInstall(args[0]);
      else if (sub === 'list') cmdPluginList();
      else if (sub === 'uninstall') cmdPluginUninstall(args[0]);
      else if (sub === 'source') {
        const [sop, ...sargs] = args;
        if (sop === 'add') cmdPluginSourceAdd(sargs[0], sargs[1]);
        else if (sop === 'list') cmdPluginSourceList();
        else if (sop === 'remove') cmdPluginSourceRemove(sargs[0]);
        else {
          console.error('unknown plugin source subcommand (try: add | list | remove)');
          process.exit(1);
        }
      } else {
        console.error('unknown plugin subcommand (try: validate | search | install | list | uninstall | source)');
        process.exit(1);
      }
      break;
    }
    case 'agent': {
      const [sub, ...args] = rest;
      if (sub === 'export') cmdAgentExport(args[0], args.slice(1));
      else if (sub === 'import') cmdAgentImport(args[0], args.slice(1));
      else {
        console.error('unknown agent subcommand (try: export | import)');
        process.exit(1);
      }
      break;
    }
    case 'team': {
      const [sub, ...args] = rest;
      if (sub === 'init') cmdTeamInit(args[0]);
      else if (sub === 'publish') cmdTeamPublish(args[0], args.slice(1));
      else if (sub === 'install') cmdTeamInstall(args[0], args[1], args.slice(2));
      else if (sub === 'list') cmdTeamList();
      else if (sub === 'agents') cmdTeamAgents(args[0]);
      else {
        console.error('unknown team subcommand (try: init | publish | install | list | agents)');
        process.exit(1);
      }
      break;
    }
    case 'doctor':
      cmdDoctor();
      break;
    case 'watch': {
      const [sub, ...args] = rest;
      if (sub === 'add') {
        if (!args[0] || !args[1]) {
          console.error('usage: omni watch add <agent-id> <url:...|file:...|cmd:...> --every "<cron>" --task "<task>" [--cooldown <mins>]');
          process.exit(1);
        }
        cmdWatchAdd(args[0], args[1], args.slice(2));
      } else if (sub === 'list') {
        cmdWatchList(args[0]);
      } else if (sub === 'remove') {
        if (!args[0]) {
          console.error('watch remove requires <watch-id>');
          process.exit(1);
        }
        cmdWatchRemove(args[0]);
      } else if (sub === 'check') {
        if (!args[0]) {
          console.error('watch check requires <watch-id>');
          process.exit(1);
        }
        await cmdWatchCheck(args[0]);
      } else if (sub === 'run') {
        try {
          await cmdWatchRun(parseTickMs(args));
        } catch (err) {
          console.error(`Error: ${errText(err)}`);
          process.exit(1);
        }
      } else {
        console.error('unknown watch subcommand (try: add | list | remove | check | run)');
        process.exit(1);
      }
      break;
    }
    case 'pack': {
      const [sub, ...args] = rest;
      if (sub === 'list') cmdPackList();
      else if (sub === 'install') cmdPackInstall(args[0], args.slice(1));
      else {
        console.error('unknown pack subcommand (try: list | install)');
        process.exit(1);
      }
      break;
    }
    case 'group': {
      const [sub, ...args] = rest;
      if (sub === 'create') cmdGroupCreate(args[0], args.slice(1));
      else if (sub === 'list') cmdGroupList();
      else if (sub === 'chat') {
        if (!args[0]) {
          console.error('group chat requires <name>');
          process.exit(1);
        }
        await cmdGroupChat(args[0]);
      } else {
        console.error('unknown group subcommand (try: create | list | chat)');
        process.exit(1);
      }
      break;
    }
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
