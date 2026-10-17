import { describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from '../src/store.js';

describe('SqliteMemoryStore', () => {
  it('remember/recall/forget roundtrip', () => {
    const store = new SqliteMemoryStore(':memory:');
    try {
      store.remember('ns1', 'color', 'blue');
      store.remember('ns1', 'pet', 'cat');

      const all = store.recall('ns1');
      expect(all).toHaveLength(2);
      expect(all.find((e) => e.key === 'color')).toMatchObject({ value: 'blue' });
      expect(all[0].updatedAt).toBeTruthy();

      expect(store.recall('ns1', 'color')).toHaveLength(1);
      expect(store.recall('ns2')).toHaveLength(0);

      store.remember('ns1', 'color', 'red'); // upsert
      expect(store.recall('ns1', 'color')[0].value).toBe('red');

      store.forget('ns1', 'color');
      expect(store.recall('ns1').map((e) => e.key)).toEqual(['pet']);
    } finally {
      store.close();
    }
  });

  it('export/import roundtrips entries including namespaces', () => {
    const a = new SqliteMemoryStore(':memory:');
    const b = new SqliteMemoryStore(':memory:');
    try {
      a.remember('ns1', 'k1', 'v1');
      a.remember('ns2', 'k2', 'v2');

      const json = a.exportJson();
      b.importJson(json);

      expect(b.recall('ns1', 'k1')[0].value).toBe('v1');
      expect(b.recall('ns2', 'k2')[0].value).toBe('v2');

      // Scoped export only carries that namespace.
      const scoped = JSON.parse(a.exportJson('ns1')) as Array<{ namespace: string }>;
      expect(scoped.every((e) => e.namespace === 'ns1')).toBe(true);
    } finally {
      a.close();
      b.close();
    }
  });

  it('importJson rejects malformed input', () => {
    const store = new SqliteMemoryStore(':memory:');
    try {
      expect(() => store.importJson('not json')).toThrow(/invalid JSON/);
      expect(() => store.importJson('{"a":1}')).toThrow(/expected a JSON array/);
      expect(() => store.importJson('[{"namespace":"n","key":1}]')).toThrow(/string namespace, key/);
    } finally {
      store.close();
    }
  });
});
