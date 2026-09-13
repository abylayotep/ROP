import { parseArgs } from 'node:util';
import { createDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { createModelClient } from '../lib/ai/openrouter.js';
import { regroupWhatsAppDrafts } from '../lib/knowledge/whatsapp-regroup.js';
import { credentialsKey } from '../lib/secret-box.js';

/**
 * One-off: rewrites each agent's open WhatsApp chat drafts (the per-phrase «База знаний из
 * WhatsApp» / «Скрипт продаж из WhatsApp» ones included) into one «Обучение из переписки» draft
 * of topic notes. Calls the agent's own OpenRouter key, so it costs money: run `--dry-run` first,
 * which runs only the cheap topic-assign step, prints every agent's `ops → topics` and each
 * `topic ← N ops`, and writes nothing.
 *
 * Usage: `node dist/scripts/regroup-whatsapp-drafts.js [--agent <id>] [--dry-run]`
 *
 * Production, from the repo root on the host:
 * `docker compose -f deploy/compose.yml --env-file deploy/.env run --rm --no-deps -T api node dist/scripts/regroup-whatsapp-drafts.js --dry-run`
 */
if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — fall back to whatever is already in the environment.
  }
}

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
try {
  const results = await regroupWhatsAppDrafts(db, {
    model: createModelClient(),
    credentialsKey: credentialsKey(env),
    log: (line) => console.log(line),
  }, { agentId: values.agent, dryRun: values['dry-run'] });
  const written = results.filter((result) => result.outcome === 'written').length;
  console.log(values['dry-run']
    ? `Dry run: ${results.length} agent(s), nothing written.`
    : `Regrouped WhatsApp drafts for ${written} of ${results.length} agent(s).`);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
