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
  /** Private Kaspi POS sidecar; cashier credentials remain encrypted per agent. */
  KASPI_POS_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Signs every webhook delivery. One per Meta application, not per client. */
  META_APP_SECRET: z.string().min(1),
  /** The string Meta echoes back during the webhook handshake. */
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  /**
   * The Meta application's id. Public by nature — it is in every Embedded Signup URL — but
   * it must match `META_APP_SECRET`, which is why both come from the same place.
   */
  META_APP_ID: z.string().min(1),
  /** The Facebook Login for Business configuration Embedded Signup runs with. */
  META_ES_CONFIG_ID: z.string().min(1),
  /**
   * 32 bytes, base64. Losing it makes every stored access token unreadable and they have
   * to be pasted again; leaking it makes them readable to whoever has the database.
   */
  CREDENTIALS_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  /** Where downloaded WhatsApp media is written. */
  MEDIA_DIR: z.string().min(1).default('var/media'),
  /**
   * How this server is reachable from the internet; shown as the webhook address.
   * No default: a missing value in production would silently point the webhook at
   * localhost, which looks like a working setup while nothing is ever delivered.
   */
  PUBLIC_URL: z.string().url(),
  /**
   * Whether owners may pair a NEW phone by QR (Baileys). On for every account unless set to
   * `false` — e.g. while Meta App Review looks at the cabinet. Numbers already paired keep
   * their reconnect controls either way.
   */
  WHATSAPP_QR_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
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
