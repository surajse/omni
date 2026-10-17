// RegistryManager: plugin sources, search, and one-command installs.
//
// Sources live in ~/.omni/registry-sources.json. A "path" source is a local
// directory; a "git" source is cloned (--depth 1) into ~/.omni/registries/<name>.
// Installed plugins materialize into ~/.omni/plugins/<name> after validation
// (or automatic .grok-plugin conversion).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importGrokPlugin } from '@omni/importers';
import { validateManifest } from '@omni/plugin-spec';
import type {
  InstallResult,
  RegistryIndex,
  RegistryPluginEntry,
  RegistrySourceRecord,
  SearchHit,
} from './types.js';

const NAME_RE = /^[a-z0-9-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertValidIndex(index: unknown, where: string): asserts index is RegistryIndex {
  if (!isRecord(index) || index['version'] !== 1 || !Array.isArray(index['plugins'])) {
    throw new Error(`invalid registry index at ${where}: expected {version: 1, plugins: [...]}`);
  }
  for (const p of index['plugins'] as unknown[]) {
    if (!isRecord(p) || typeof p['name'] !== 'string' || typeof p['version'] !== 'string' || !isRecord(p['source'])) {
      throw new Error(`invalid registry index at ${where}: each plugin needs name, version, and source`);
    }
    const s = p['source'] as Record<string, unknown>;
    if (s['type'] !== 'path' && s['type'] !== 'git') {
      throw new Error(`invalid registry index at ${where}: plugin source type must be "path" or "git"`);
    }
  }
}

function checkGit(): void {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('git is not available: cannot use git registry sources or plugins');
  }
}

export class RegistryManager {
  constructor(private readonly home: string) {}

  private get sourcesFile(): string {
    return join(this.home, 'registry-sources.json');
  }

  private get clonesDir(): string {
    return join(this.home, 'registries');
  }

  private get cacheDir(): string {
    return join(this.home, 'registry-cache');
  }

  private get pluginsDir(): string {
    return join(this.home, 'plugins');
  }

  private readSources(): RegistrySourceRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.sourcesFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`corrupt registry sources file: ${this.sourcesFile}`);
    return parsed as RegistrySourceRecord[];
  }

  private writeSources(sources: RegistrySourceRecord[]): void {
    mkdirSync(this.home, { recursive: true });
    writeFileSync(this.sourcesFile, JSON.stringify(sources, null, 2) + '\n', 'utf8');
  }

  /** Register a source: a local directory, or a git URL (cloned shallow). */
  addSource(name: string, location: string): RegistrySourceRecord {
    if (!NAME_RE.test(name)) {
      throw new Error(`invalid source name "${name}": must match ${NAME_RE.source}`);
    }
    const sources = this.readSources();
    if (sources.some((s) => s.name === name)) {
      throw new Error(`registry source already exists: ${name}`);
    }
    let record: RegistrySourceRecord;
    if (existsSync(location) && statSync(location).isDirectory()) {
      record = { name, location: resolve(location), kind: 'path', addedAt: new Date().toISOString() };
    } else {
      checkGit();
      const dest = join(this.clonesDir, name);
      if (existsSync(dest)) {
        throw new Error(`registry clone dir already exists: ${dest} (remove it or pick another name)`);
      }
      mkdirSync(this.clonesDir, { recursive: true });
      try {
        execFileSync('git', ['clone', '--depth', '1', location, dest], { stdio: 'pipe' });
      } catch (err) {
        throw new Error(`git clone failed for ${location}: ${err instanceof Error ? err.message : String(err)}`);
      }
      record = { name, location, kind: 'git', addedAt: new Date().toISOString() };
    }
    sources.push(record);
    this.writeSources(sources);
    return record;
  }

  removeSource(name: string): void {
    const sources = this.readSources();
    const found = sources.find((s) => s.name === name);
    if (!found) throw new Error(`unknown registry source: ${name}`);
    if (found.kind === 'git') {
      const dest = join(this.clonesDir, name);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    }
    this.writeSources(sources.filter((s) => s.name !== name));
  }

  listSources(): RegistrySourceRecord[] {
    return this.readSources();
  }

  private indexDirFor(source: RegistrySourceRecord): string {
    return source.kind === 'path' ? source.location : join(this.clonesDir, source.name);
  }

  private loadIndex(source: RegistrySourceRecord): RegistryIndex {
    const dir = this.indexDirFor(source);
    const path = join(dir, 'index.json');
    if (!existsSync(path)) {
      throw new Error(`registry source "${source.name}" has no index.json at ${path}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    assertValidIndex(parsed, path);
    return parsed;
  }

  /** Substring search (case-insensitive) over name, description, and keywords. */
  search(query: string): SearchHit[] {
    const q = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (const source of this.readSources()) {
      const index = this.loadIndex(source);
      for (const plugin of index.plugins) {
        const haystack = [plugin.name, plugin.description ?? '', ...(plugin.keywords ?? [])]
          .join(' ')
          .toLowerCase();
        if (haystack.includes(q)) {
          hits.push({ ...plugin, sourceName: source.name });
        }
      }
    }
    return hits;
  }

  private resolvePluginDir(source: RegistrySourceRecord, entry: RegistryPluginEntry): string {
    const src = entry.source;
    if (src.type === 'path') {
      if (!src.path) throw new Error(`plugin "${entry.name}": path source is missing "path"`);
      const dir = resolve(this.indexDirFor(source), src.path);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`plugin "${entry.name}": directory not found at ${dir}`);
      }
      return dir;
    }
    // type === 'git'
    const url = (src as { url?: unknown }).url;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`plugin "${entry.name}": git source is missing "url"`);
    }
    checkGit();
    const dest = join(this.cacheDir, entry.name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(this.cacheDir, { recursive: true });
    try {
      execFileSync('git', ['clone', '--depth', '1', url, dest], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`git clone failed for plugin "${entry.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    return dest;
  }

  /**
   * Install a plugin by name from the first source that lists it.
   * Validates omni.plugin.json, or auto-converts a .grok-plugin layout.
   */
  install(name: string): InstallResult {
    const hits = this.search(name).filter((h) => h.name.toLowerCase() === name.toLowerCase());
    if (hits.length === 0) {
      throw new Error(`plugin not found in any registry source: ${name}`);
    }
    const hit = hits[0]!;
    const source = this.readSources().find((s) => s.name === hit.sourceName)!;
    const dest = join(this.pluginsDir, hit.name);
    if (existsSync(dest)) {
      throw new Error(`plugin already installed: ${hit.name} (remove it first to reinstall)`);
    }
    const pluginDir = this.resolvePluginDir(source, hit);
    mkdirSync(this.pluginsDir, { recursive: true });
    cpSync(pluginDir, dest, { recursive: true });

    const manifestPath = join(dest, 'omni.plugin.json');
    let convertedFromGrok = false;
    if (existsSync(manifestPath)) {
      const result = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      if (!result.ok) {
        rmSync(dest, { recursive: true, force: true });
        throw new Error(`plugin "${hit.name}" has an invalid omni.plugin.json: ${result.errors.join('; ')}`);
      }
    } else if (existsSync(join(dest, '.grok-plugin'))) {
      const { manifest, skillFiles } = importGrokPlugin(dest);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      for (const skill of skillFiles) {
        const skillDir = join(dest, 'skills', skill.name);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), skill.markdown, 'utf8');
      }
      convertedFromGrok = true;
    } else {
      rmSync(dest, { recursive: true, force: true });
      throw new Error(
        `plugin "${hit.name}" is neither an Omni plugin (no omni.plugin.json) nor a .grok-plugin`,
      );
    }
    return { name: hit.name, version: hit.version, installedPath: dest, convertedFromGrok };
  }

  listInstalled(): string[] {
    try {
      return readdirSync(this.pluginsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  installedPath(name: string): string {
    const dest = join(this.pluginsDir, name);
    if (!existsSync(dest)) throw new Error(`plugin not installed: ${name}`);
    return dest;
  }

  removeInstalled(name: string): void {
    const dest = join(this.pluginsDir, name);
    if (!existsSync(dest)) throw new Error(`plugin not installed: ${name}`);
    rmSync(dest, { recursive: true, force: true });
  }
}
