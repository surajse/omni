// Omni plugin manifest schema (v1.0) and hand-rolled validator.

export type ToolSource =
  | { kind: 'mcp-stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: 'http'; baseUrl: string }
  | { kind: 'builtin'; ref: string };

export interface PluginTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly?: boolean;
  source: ToolSource;
}

export interface OmniPluginManifest {
  manifestVersion: '1.0';
  name: string;
  version: string;
  description?: string;
  author?: string;
  tools: PluginTool[];
  channels?: string[];
  permissions?: string[];
}

export type ValidationResult =
  | { ok: true; manifest: OmniPluginManifest }
  | { ok: false; errors: string[] };

const NAME_RE = /^[a-z0-9-]{3,64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateToolSource(source: unknown, path: string, errors: string[]): void {
  if (!isRecord(source)) {
    errors.push(`${path}: source must be an object`);
    return;
  }
  const kind = source['kind'];
  if (kind === 'mcp-stdio') {
    if (typeof source['command'] !== 'string' || source['command'].length === 0) {
      errors.push(`${path}: mcp-stdio source requires a non-empty "command" string`);
    }
    if (source['args'] !== undefined && (!Array.isArray(source['args']) || !source['args'].every((a) => typeof a === 'string'))) {
      errors.push(`${path}: mcp-stdio source "args" must be an array of strings`);
    }
    if (
      source['env'] !== undefined &&
      (!isRecord(source['env']) || !Object.values(source['env']).every((v) => typeof v === 'string'))
    ) {
      errors.push(`${path}: mcp-stdio source "env" must be a record of strings`);
    }
  } else if (kind === 'http') {
    if (typeof source['baseUrl'] !== 'string' || source['baseUrl'].length === 0) {
      errors.push(`${path}: http source requires a non-empty "baseUrl" string`);
    }
  } else if (kind === 'builtin') {
    if (typeof source['ref'] !== 'string' || source['ref'].length === 0) {
      errors.push(`${path}: builtin source requires a non-empty "ref" string`);
    }
  } else {
    errors.push(`${path}: unknown source kind ${JSON.stringify(kind)} (expected "mcp-stdio", "http", or "builtin")`);
  }
}

export function validateManifest(json: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(json)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }

  if (json['manifestVersion'] !== '1.0') {
    errors.push(`manifestVersion must be "1.0", got ${JSON.stringify(json['manifestVersion'])}`);
  }

  const name = json['name'];
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    errors.push(
      `name must be a string matching ${NAME_RE.source} (3-64 lowercase alphanumerics/dashes), got ${JSON.stringify(name)}`,
    );
  }

  const version = json['version'];
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    errors.push(`version must be semver (e.g. "1.2.3"), got ${JSON.stringify(version)}`);
  }

  for (const field of ['description', 'author'] as const) {
    if (json[field] !== undefined && typeof json[field] !== 'string') {
      errors.push(`${field} must be a string when present`);
    }
  }

  const tools = json['tools'];
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push('tools must be a non-empty array');
  } else {
    const seen = new Set<string>();
    tools.forEach((t, i) => {
      const path = `tools[${i}]`;
      if (!isRecord(t)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      const tname = t['name'];
      if (typeof tname !== 'string' || tname.length === 0) {
        errors.push(`${path}.name must be a non-empty string`);
      } else if (seen.has(tname)) {
        errors.push(`${path}.name: duplicate tool name "${tname}"`);
      } else {
        seen.add(tname);
      }
      if (typeof t['description'] !== 'string' || t['description'].length === 0) {
        errors.push(`${path}.description must be a non-empty string`);
      }
      if (!isRecord(t['parameters'])) {
        errors.push(`${path}.parameters must be an object (JSON Schema)`);
      }
      if (t['readOnly'] !== undefined && typeof t['readOnly'] !== 'boolean') {
        errors.push(`${path}.readOnly must be a boolean when present`);
      }
      validateToolSource(t['source'], `${path}.source`, errors);
    });
  }

  for (const field of ['channels', 'permissions'] as const) {
    const v = json[field];
    if (v !== undefined && (!Array.isArray(v) || !v.every((s) => typeof s === 'string'))) {
      errors.push(`${field} must be an array of strings when present`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: json as unknown as OmniPluginManifest };
}
