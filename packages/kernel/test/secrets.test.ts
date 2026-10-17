import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../src/secrets.js';

describe('scrubSecrets', () => {
  it('redacts JSON-style credentials', () => {
    const out = scrubSecrets('{"api_key": "sk-abc123", "user": "bob", "password": "hunter2"}');
    expect(out).toContain('"api_key": "[REDACTED]"');
    expect(out).toContain('"password": "[REDACTED]"');
    expect(out).toContain('"user": "bob"');
    expect(out).not.toContain('sk-abc123');
    expect(out).not.toContain('hunter2');
  });

  it('redacts env-style assignments without touching normal prose', () => {
    const out = scrubSecrets('OPENAI_API_KEY=sk-live-xyz\ntoken: abc.def.ghi\nthe secret plan is safe');
    expect(out).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(out).toContain('token: [REDACTED]');
    expect(out).toContain('the secret plan is safe');
  });

  it('redacts Bearer tokens in headers', () => {
    const out = scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('handles client_secret, passwd, and unquoted JSON values', () => {
    const out = scrubSecrets('{"client_secret": "shh", "retries": 3}\nDB_PASSWD=hunter2');
    expect(out).toBe('{"client_secret": "[REDACTED]", "retries": 3}\nDB_PASSWD=[REDACTED]');
  });

  it('leaves non-secret text untouched', () => {
    const text = 'remember to water the plants\n{"name": "scout", "enabled": true}';
    expect(scrubSecrets(text)).toBe(text);
  });
});
