// Importer for xAI's `.grok-plugin` format (as used by xai-org/plugin-marketplace).
//
// A Grok plugin directory contains:
//   .grok-plugin/plugin.json  {name, version, description, author: {name,url}|string, ...}
//   .mcp.json                 {mcpServers: {<srv>: {type:"http",url} | {type:"stdio",command,args?,env?}}}
//   skills/<skill>/SKILL.md   optional skill docs
//   assets/, README.md        ignored by the importer
//
// The importer converts this into an OmniPluginManifest (tools become
// `discover: true` MCP tools) and captures any SKILL.md files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest, type OmniPluginManifest, type PluginTool } from '@omni/plugin-spec';

export interface GrokSkillFile {
  name: string;
  markdown: string;
}

export interface GrokImportResult {
  manifest: OmniPluginManifest;
  skillFiles: GrokSkillFile[];
}

const NAME_RE = /^[a-z0-9-]{3,64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJson(dir: string, rel: string): unknown {
  const path = join(dir, rel);
  if (!existsSync(path)) {
    throw new Error(`grok import: missing ${rel} in ${dir}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`grok import: invalid JSON in ${rel}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Sanitize an arbitrary name to the omni `^[a-z0-9-]+$` shape. */
export function sanitizePluginName(raw: string): string {
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!clean || !NAME_RE.test(clean)) {
    throw new Error(`grok import: cannot sanitize plugin name ${JSON.stringify(raw)}`);
  }
  return clean;
}

function sanitizeToolName(raw: string): string {
  if (TOOL_NAME_RE.test(raw)) return raw;
  const clean = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64) || 'tool';
  if (!TOOL_NAME_RE.test(clean)) throw new Error(`grok import: cannot sanitize tool name ${JSON.stringify(raw)}`);
  return clean;
}

function toAuthorString(author: unknown): string | undefined {
  if (typeof author === 'string') return author;
  if (isRecord(author) && typeof author['name'] === 'string') return author['name'];
  return undefined;
}

function mcpServerToTool(srvName: string, srv: unknown): PluginTool {
  if (!isRecord(srv)) throw new Error(`grok import: mcp server "${srvName}" must be an object`);
  const type = srv['type'];
  const toolName = sanitizeToolName(srvName);
  const base = {
    name: toolName,
    description: `MCP server '${srvName}' (imported from Grok plugin)`,
    parameters: { type: 'object', properties: {} },
    readOnly: false,
    discover: true,
  };
  if (type === 'http') {
    if (typeof srv['url'] !== 'string' || srv['url'].length === 0) {
      throw new Error(`grok import: http mcp server "${srvName}" needs a "url"`);
    }
    return { ...base, source: { kind: 'mcp-http', url: srv['url'] } };
  }
  if (type === 'stdio') {
    if (typeof srv['command'] !== 'string' || srv['command'].length === 0) {
      throw new Error(`grok import: stdio mcp server "${srvName}" needs a "command"`);
    }
    const args = srv['args'];
    const env = srv['env'];
    return {
      ...base,
      source: {
        kind: 'mcp-stdio',
        command: srv['command'],
        ...(Array.isArray(args) && args.every((a) => typeof a === 'string') ? { args: args as string[] } : {}),
        ...(isRecord(env) && Object.values(env).every((v) => typeof v === 'string')
          ? { env: env as Record<string, string> }
          : {}),
      },
    };
  }
  throw new Error(`grok import: mcp server "${srvName}" has unknown type ${JSON.stringify(type)} (expected "http" or "stdio")`);
}

function collectSkillFiles(dir: string): GrokSkillFile[] {
  const skillsDir = join(dir, 'skills');
  if (!existsSync(skillsDir)) return [];
  const out: GrokSkillFile[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const mdPath = join(skillsDir, entry, 'SKILL.md');
    if (existsSync(mdPath)) {
      out.push({ name: entry, markdown: readFileSync(mdPath, 'utf8') });
    }
  }
  return out;
}

/**
 * Convert a `.grok-plugin` directory into an Omni manifest plus skill files.
 * Throws a descriptive error when the layout is not a valid Grok plugin.
 */
export function importGrokPlugin(dir: string): GrokImportResult {
  const pluginJson = readJson(dir, '.grok-plugin/plugin.json');
  if (!isRecord(pluginJson)) throw new Error('grok import: .grok-plugin/plugin.json must be an object');

  const rawName = pluginJson['name'];
  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw new Error('grok import: .grok-plugin/plugin.json needs a non-empty "name"');
  }
  const version = pluginJson['version'];
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new Error(`grok import: "version" must be semver, got ${JSON.stringify(version)}`);
  }

  const mcpJson = readJson(dir, '.mcp.json');
  if (!isRecord(mcpJson) || !isRecord(mcpJson['mcpServers'])) {
    throw new Error('grok import: .mcp.json must contain an "mcpServers" object');
  }
  const servers = mcpJson['mcpServers'] as Record<string, unknown>;
  const names = Object.keys(servers);
  if (names.length === 0) throw new Error('grok import: .mcp.json "mcpServers" is empty');
  const tools = names.map((n) => mcpServerToTool(n, servers[n]));

  const manifest: OmniPluginManifest = {
    manifestVersion: '1.0',
    name: sanitizePluginName(rawName),
    version,
    description: typeof pluginJson['description'] === 'string' ? pluginJson['description'] : undefined,
    author: toAuthorString(pluginJson['author']),
    tools,
    permissions: ['network'],
  };

  const validated = validateManifest(manifest);
  if (!validated.ok) {
    throw new Error(`grok import: converted manifest is invalid: ${validated.errors.join('; ')}`);
  }
  return { manifest: validated.manifest, skillFiles: collectSkillFiles(dir) };
}
