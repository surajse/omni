// Namespaced key/value memory backed by node:sqlite (DatabaseSync).
import { DatabaseSync } from 'node:sqlite';

export interface MemoryEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export interface MemoryStore {
  remember(namespace: string, key: string, value: string): void;
  recall(namespace: string, key?: string): MemoryEntry[];
  forget(namespace: string, key: string): void;
  exportJson(namespace?: string): string;
  importJson(json: string): void;
  close(): void;
}

interface Row {
  namespace: string;
  key: string;
  value: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
)`;

function toEntry(row: Row): MemoryEntry {
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;

  /** `path` is a file path, or `':memory:'` for an ephemeral store. */
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  remember(namespace: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO memories (namespace, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (namespace, key)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(namespace, key, value, new Date().toISOString());
  }

  recall(namespace: string, key?: string): MemoryEntry[] {
    const rows =
      key === undefined
        ? (this.db
            .prepare('SELECT namespace, key, value, updated_at FROM memories WHERE namespace = ? ORDER BY key')
            .all(namespace) as unknown as Row[])
        : (this.db
            .prepare('SELECT namespace, key, value, updated_at FROM memories WHERE namespace = ? AND key = ?')
            .all(namespace, key) as unknown as Row[]);
    return rows.map(toEntry);
  }

  forget(namespace: string, key: string): void {
    this.db.prepare('DELETE FROM memories WHERE namespace = ? AND key = ?').run(namespace, key);
  }

  exportJson(namespace?: string): string {
    const rows =
      namespace === undefined
        ? (this.db.prepare('SELECT namespace, key, value, updated_at FROM memories ORDER BY namespace, key').all() as unknown as Row[])
        : (this.db
            .prepare('SELECT namespace, key, value, updated_at FROM memories WHERE namespace = ? ORDER BY key')
            .all(namespace) as unknown as Row[]);
    return JSON.stringify(rows.map(toEntry).map((e, i) => ({ ...e, namespace: rows[i].namespace })), null, 2);
  }

  importJson(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('importJson: invalid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('importJson: expected a JSON array of entries');
    }
    for (const item of parsed) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as { namespace?: unknown }).namespace !== 'string' ||
        typeof (item as { key?: unknown }).key !== 'string' ||
        typeof (item as { value?: unknown }).value !== 'string'
      ) {
        throw new Error('importJson: each entry must have string namespace, key, and value');
      }
      const entry = item as { namespace: string; key: string; value: string; updatedAt?: unknown };
      const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO memories (namespace, key, value, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (namespace, key)
           DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(entry.namespace, entry.key, entry.value, updatedAt);
    }
  }

  close(): void {
    this.db.close();
  }
}
