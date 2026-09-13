import { createDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { mergeDuplicateWhatsAppDrafts } from '../lib/knowledge/whatsapp-drafts.js';

/**
 * One-off cleanup: leaves each agent with one open «База знаний из WhatsApp» and one
 * «Скрипт продаж из WhatsApp» draft, merging the older duplicates into them. Safe to rerun.
 *
 * Production: `docker compose run --rm server node dist/scripts/merge-whatsapp-drafts.js`.
 */
if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — fall back to whatever is already in the environment.
  }
}

const db = createDb(loadEnv().DATABASE_URL);
try {
  const changed = await mergeDuplicateWhatsAppDrafts(db);
  console.log(`Merged WhatsApp drafts for ${changed} agent(s).`);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
