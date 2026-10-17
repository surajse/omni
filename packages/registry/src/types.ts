// Registry index types. A registry is a directory containing index.json:
//
//   {
//     "version": 1,
//     "plugins": [
//       { "name": "hello", "version": "0.1.0", "description": "...",
//         "keywords": ["example"],
//         "source": { "type": "path", "path": "plugins/hello" } }
//     ]
//   }
//
// "path" sources are resolved relative to the directory holding index.json.

export interface RegistryPluginSource {
  type: 'git' | 'path';
  /** For "path": relative to the index.json directory. */
  path?: string;
}

export interface RegistryPluginEntry {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  source: RegistryPluginSource;
}

export interface RegistryIndex {
  version: 1;
  plugins: RegistryPluginEntry[];
}

/** A configured registry source (persisted in ~/.omni/registry-sources.json). */
export interface RegistrySourceRecord {
  name: string;
  /** "path" = local directory; "git" = cloned into ~/.omni/registries/<name>. */
  location: string;
  kind: 'path' | 'git';
  addedAt: string;
}

export interface SearchHit extends RegistryPluginEntry {
  sourceName: string;
}

export interface InstallResult {
  name: string;
  version: string;
  installedPath: string;
  /** True when the plugin was a .grok-plugin converted on install. */
  convertedFromGrok: boolean;
}
