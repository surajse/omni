import { describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from '../src/store.js';

describe('SqliteMemoryStore vectors', () => {
  it('round-trips embeddings through BLOB storage', () => {
    const store = new SqliteMemoryStore();
    try {
      store.rememberVec('ns', 'k1', 'alpha doc', [1, 0, 0]);
      const hits = store.semanticRecall('ns', [1, 0, 0], 5);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ key: 'k1', value: 'alpha doc', score: 1 });
    } finally {
      store.close();
    }
  });

  it('ranks nearest vectors first', () => {
    const store = new SqliteMemoryStore();
    try {
      store.rememberVec('ns', 'far', 'unrelated', [0, 0, 1]);
      store.rememberVec('ns', 'near', 'close match', [0.9, 0.1, 0]);
      store.rememberVec('ns', 'mid', 'somewhat', [0.5, 0.5, 0]);
      const hits = store.semanticRecall('ns', [1, 0, 0], 3);
      expect(hits.map((h) => h.key)).toEqual(['near', 'mid', 'far']);
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    } finally {
      store.close();
    }
  });

  it('respects k and isolates namespaces', () => {
    const store = new SqliteMemoryStore();
    try {
      store.rememberVec('a', 'k1', 'v1', [1, 0]);
      store.rememberVec('a', 'k2', 'v2', [0.9, 0.1]);
      store.rememberVec('b', 'k1', 'other ns', [1, 0]);
      expect(store.semanticRecall('a', [1, 0], 1)).toHaveLength(1);
      expect(store.semanticRecall('b', [1, 0], 5).map((h) => h.value)).toEqual(['other ns']);
      expect(store.semanticRecall('empty', [1, 0], 5)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('skips dimension mismatches and rejects empty embeddings', () => {
    const store = new SqliteMemoryStore();
    try {
      store.rememberVec('ns', 'k1', 'v1', [1, 0]);
      // 3-dim query against 2-dim rows: no crash, no hits
      expect(store.semanticRecall('ns', [1, 0, 0], 5)).toEqual([]);
      expect(() => store.rememberVec('ns', 'k2', 'v2', [])).toThrow(/must not be empty/);
    } finally {
      store.close();
    }
  });

  it('upserts on key conflict', () => {
    const store = new SqliteMemoryStore();
    try {
      store.rememberVec('ns', 'k', 'old', [1, 0]);
      store.rememberVec('ns', 'k', 'new', [0, 1]);
      const hits = store.semanticRecall('ns', [0, 1], 5);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.value).toBe('new');
    } finally {
      store.close();
    }
  });
});
