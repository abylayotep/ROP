import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const valid = {
  DATABASE_URL: 'postgres://rakurs:rakurs@localhost:5432/rakurs',
  SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('names the offending variable when one is missing', () => {
    expect(() => loadEnv({ SESSION_SECRET: valid.SESSION_SECRET } as NodeJS.ProcessEnv))
      .toThrow(/DATABASE_URL/);
  });

  it('rejects a session secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: 'short' } as NodeJS.ProcessEnv))
      .toThrow(/SESSION_SECRET/);
  });

  it('defaults the port to 3000 and coerces a string port', () => {
    expect(loadEnv(valid).PORT).toBe(3000);
    expect(loadEnv({ ...valid, PORT: '8080' } as NodeJS.ProcessEnv).PORT).toBe(8080);
  });
});
