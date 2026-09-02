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
  /** Signs every webhook delivery. One per Meta application, not per client. */
  META_APP_SECRET: z.string().min(1),
  /** The string Meta echoes back during the webhook handshake. */
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  /**
   * 32 bytes, base64. Losing it makes every stored access token unreadable and they have
   * to be pasted again; leaking it makes them readable to whoever has the database.
   */
  CREDENTIALS_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  /** Where downloaded WhatsApp media is written. */
  MEDIA_DIR: z.string().min(1).default('var/media'),
  /** How this server is reachable from the internet; shown as the webhook address. */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
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
