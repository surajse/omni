// Agent artifacts: rich static HTML the agent can publish for the web
// console's Artifacts tab (charts, styled reports, dashboards).
//
// Same path-traversal jail as doc.write. JavaScript is intentionally NOT
// supported in the viewer (the console renders artifacts in an <iframe
// sandbox=""> with scripts disabled) — artifacts are static documents,
// not apps. Size caps keep one bad save from filling the disk.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveDocPath } from './docs.js';
import type { ToolDefinition } from './types.js';
import type { ToolGateway } from './tools.js';

/** Max bytes for a single artifact (HTML). */
export const MAX_ARTIFACT_BYTES = 512 * 1024;
/** Max total bytes across all of an agent's artifacts. */
export const MAX_ARTIFACTS_DIR_BYTES = 10 * 1024 * 1024;

/** Normalize an artifact name: must end in .html, must stay jailed. */
export function resolveArtifactPath(root: string, name: string): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('artifact: "name" must be a non-empty string');
  }
  const file = name.trim().endsWith('.html') ? name.trim() : `${name.trim()}.html`;
  return resolveDocPath(root, file);
}

/** Total bytes of regular files directly under root (non-recursive is enough — jail keeps it flat-ish, but walk anyway). */
export function artifactsDirBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        try {
          total += statSync(abs).size;
        } catch {
          // ignore races
        }
      }
    }
  };
  walk(root);
  return total;
}

/** List artifact file names (relative, forward slashes), sorted. */
export function listArtifactFiles(root: string): string[] {
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
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (e.isFile() && e.name.endsWith('.html')) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

/** Register artifact.save / artifact.list on a gateway, jailed to artifactsDir. */
export function registerArtifactTools(gateway: ToolGateway, artifactsDir: string): void {
  mkdirSync(artifactsDir, { recursive: true });

  const saveDef: ToolDefinition = {
    name: 'artifact.save',
    description:
      'Save a rich static HTML artifact (report, chart, dashboard) for the web console Artifacts tab. ' +
      'Name is a file name (".html" is added when missing). JavaScript will NOT run in the viewer — ' +
      'use inline CSS/SVG only. Max 512KB per artifact, 10MB total.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, html: { type: 'string' } },
      required: ['name', 'html'],
    },
    readOnly: false,
  };
  const listDef: ToolDefinition = {
    name: 'artifact.list',
    description: 'List saved HTML artifacts for the web console Artifacts tab.',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
  };

  gateway.register(saveDef, (args) => {
    const html = args['html'];
    if (typeof html !== 'string' || !html.trim()) {
      throw new Error('artifact: "html" must be a non-empty string');
    }
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `artifact: html is ${bytes} bytes, over the ${MAX_ARTIFACT_BYTES}-byte per-artifact cap`,
      );
    }
    const abs = resolveArtifactPath(artifactsDir, args['name'] as string);
    const current = artifactsDirBytes(artifactsDir);
    let existing = 0;
    try {
      existing = statSync(abs).size;
    } catch {
      existing = 0;
    }
    if (current - existing + bytes > MAX_ARTIFACTS_DIR_BYTES) {
      throw new Error(
        `artifact: saving would exceed the ${MAX_ARTIFACTS_DIR_BYTES}-byte artifacts directory cap`,
      );
    }
    writeFileSync(abs, html, 'utf8');
    return `saved artifact ${relative(artifactsDir, abs)} (${bytes} bytes)`;
  });

  gateway.register(listDef, () => {
    const files = listArtifactFiles(artifactsDir);
    return files.length > 0 ? files.join('\n') : '(no artifacts)';
  });
}
