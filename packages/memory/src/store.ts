// Namespaced key/value memory backed by node:sqlite (DatabaseSync).
import { DatabaseSync } from 'node:sqlite';
import { isSecretKey, scrubSecrets } from '@omni/kernel';
import { cosine } from './vector.js';

export interface MemoryEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export interface VectorEntry {
  key: string;
  value: string;
  /** Cosine similarity of the stored embedding to the query embedding. */
  score: number;
}

export interface MemoryStore {
  remember(namespace: string, key: string, value: string): void;
  recall(namespace: string, key?: string): MemoryEntry[];
  forget(namespace: string, key: string): void;
  exportJson(namespace?: string): string;
  importJson(json: string): void;
  close(): void;
}

/** Optional vector capability. SqliteMemoryStore implements it; the kernel
 *  detects it structurally so the kernel never hard-depends on it. */
export interface VectorMemoryStore {
  rememberVec(namespace: string, key: string, value: string, embedding: number[]): void;
  semanticRecall(namespace: string, queryEmbedding: number[], k?: number): VectorEntry[];
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
);
CREATE TABLE IF NOT EXISTS memory_vectors (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dim INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
)`;

function toEntry(row: Row): MemoryEntry {
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}

/** Encode an embedding as little-endian float32 bytes for BLOB storage. */
function encodeEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

function decodeEmbedding(blob: Buffer): number[] {
  if (blob.length % 4 !== 0) throw new Error('decodeEmbedding: corrupt embedding blob');
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4));
}

interface VectorRow {
  key: string;
  value: string;
  embedding: Buffer;
  dim: number;
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

  /**
   * Store a value with its embedding for semantic recall. Embeddings are
   * compared with brute-force cosine similarity — honest at personal scale
   * (hundreds of entries); ANN indexing is future work, see docs.
   */
  rememberVec(namespace: string, key: string, value: string, embedding: number[]): void {
    if (embedding.length === 0) throw new Error('rememberVec: embedding must not be empty');
    this.db
      .prepare(
        `INSERT INTO memory_vectors (namespace, key, value, embedding, dim, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (namespace, key)
         DO UPDATE SET value = excluded.value, embedding = excluded.embedding,
                       dim = excluded.dim, updated_at = excluded.updated_at`,
      )
      .run(namespace, key, value, encodeEmbedding(embedding), embedding.length, new Date().toISOString());
  }

  /** Top-k entries in `namespace` by cosine similarity to `queryEmbedding`. */
  semanticRecall(namespace: string, queryEmbedding: number[], k = 5): VectorEntry[] {
    const rows = this.db
      .prepare('SELECT key, value, embedding, dim FROM memory_vectors WHERE namespace = ?')
      .all(namespace) as unknown as VectorRow[];
    const scored: VectorEntry[] = [];
    for (const row of rows) {
      let emb: number[];
      try {
        emb = decodeEmbedding(row.embedding);
      } catch {
        continue; // corrupt row: skip rather than fail the whole recall
      }
      if (emb.length !== queryEmbedding.length) continue; // dim mismatch: skip
      scored.push({ key: row.key, value: row.value, score: cosine(queryEmbedding, emb) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k));
  }

  /** Export entries as JSON. Credential-looking values are scrubbed — an export is safe to share. */
  exportJson(namespace?: string): string {
    const rows =
      namespace === undefined
        ? (this.db.prepare('SELECT namespace, key, value, updated_at FROM memories ORDER BY namespace, key').all() as unknown as Row[])
        : (this.db
            .prepare('SELECT namespace, key, value, updated_at FROM memories WHERE namespace = ? ORDER BY key')
            .all(namespace) as unknown as Row[]);
    const entries = rows.map(toEntry).map((e, i) => ({
      ...e,
      namespace: rows[i].namespace,
      // The secret lives in the value field here ({"key":"api_key","value":"..."}),
      // so redact by key name before serializing; scrubSecrets is defense in depth.
      value: isSecretKey(e.key) ? '[REDACTED]' : e.value,
    }));
    return scrubSecrets(JSON.stringify(entries, null, 2));
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
