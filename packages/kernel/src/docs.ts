// Agent document workspace: doc.read/write/list/append tools backed by a
// per-agent docs directory. All paths are jailed inside docsDir — a
// traversal attack (`../escape`) throws instead of escaping.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ToolDefinition } from './types.js';
import type { ToolGateway } from './tools.js';

/**
 * Resolve a user-supplied relative path inside `root`. Throws on absolute
 * paths, `..` escapes, or the root itself.
 */
export function resolveDocPath(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('doc: "path" must be a non-empty string');
  }
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`doc: path escapes the docs directory: ${relPath}`);
  }
  return abs;
}

/** Recursively list files under root, as forward-slash relative paths. */
export function listDocFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  const walk = (dir: string, relBase: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Recurse when the prefix could still match something inside.
        if (!prefix || rel.startsWith(prefix) || prefix.startsWith(`${rel}/`)) {
          walk(join(dir, e.name), rel);
        }
      } else if (e.isFile()) {
        if (!prefix || rel.startsWith(prefix)) out.push(rel);
      }
    }
  };
  walk(root, '');
  return out;
}

function strArg(args: Record<string, unknown>, name: string, required = true): string {
  const v = args[name];
  if (typeof v !== 'string' || (required && !v.trim())) {
    throw new Error(`doc: "${name}" must be a non-empty string`);
  }
  return v;
}

/** Register doc.read/write/list/append on a gateway, jailed to docsDir. */
export function registerDocTools(gateway: ToolGateway, docsDir: string): void {
  mkdirSync(docsDir, { recursive: true });

  const defs: ToolDefinition[] = [
    {
      name: 'doc.write',
      description: 'Write (create or overwrite) a document in the agent docs workspace. Path is relative to the docs root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      readOnly: false,
    },
    {
      name: 'doc.read',
      description: 'Read a document from the agent docs workspace. Path is relative to the docs root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      readOnly: true,
    },
    {
      name: 'doc.list',
      description: 'List documents in the agent docs workspace, optionally filtered by a path prefix.',
      parameters: { type: 'object', properties: { prefix: { type: 'string' } } },
      readOnly: true,
    },
    {
      name: 'doc.append',
      description: 'Append content to a document in the agent docs workspace (creates it if missing).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      readOnly: false,
    },
  ];

  gateway.register(defs[0]!, (args) => {
    const abs = resolveDocPath(docsDir, strArg(args, 'path'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, strArg(args, 'content', false), 'utf8');
    return `wrote ${relative(docsDir, abs)}`;
  });

  gateway.register(defs[1]!, (args) => {
    const abs = resolveDocPath(docsDir, strArg(args, 'path'));
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      throw new Error(`doc: not found: ${args['path']}`);
    }
  });

  gateway.register(defs[2]!, (args) => {
    const prefix = typeof args['prefix'] === 'string' ? args['prefix'] : '';
    const files = listDocFiles(docsDir, prefix);
    return files.length > 0 ? files.join('\n') : '(no documents)';
  });

  gateway.register(defs[3]!, (args) => {
    const abs = resolveDocPath(docsDir, strArg(args, 'path'));
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, strArg(args, 'content', false), 'utf8');
    return `appended to ${relative(docsDir, abs)}`;
  });
}

/** True when the path is an existing regular file inside root. */
export function docFileExists(root: string, relPath: string): boolean {
  try {
    return statSync(resolveDocPath(root, relPath)).isFile();
  } catch {
    return false;
  }
}
