import { z } from 'zod';

/**
 * Every environment variable the server needs, validated once at boot.
 *
 * Validation is deliberately loud and early: a process that starts with a missing
 * variable and fails hours later inside a background job is far harder to diagnose
 * than one that refuses to start at all.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
