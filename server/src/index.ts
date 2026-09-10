import { reconcileOrphanedRuns } from './api/drafts.js';
import { buildServer } from './api/server.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';
import { createCapiClient } from './lib/capi/client.js';
import { sendPendingCapiEvents } from './lib/capi/queue.js';
import { credentialsKey } from './lib/secret-box.js';

// Local convenience only. In production Compose supplies the environment and there is
// no .env in the image, so the absence of the file is the normal case, not an error.
if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — fall back to whatever is already in the environment.
  }
}

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
// Built here rather than inside `buildServer`, so the timer below and the webhook's drain
// are the same client and one deadline governs both.
const capi = createCapiClient();
const app = buildServer(env, db, { capi });

// Before this process takes a single request — see `api/drafts.ts`'s own comment on why a
// `running` test run left behind by a dead process needs this, and why it runs here rather
// than on a hook every test's own `buildServer` would trip too.
await reconcileOrphanedRuns(db);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

/**
 * The Conversions API queue, on a clock as well as on the webhook.
 *
 * The webhook drain alone is not enough, and this is why: a seller marks Friday evening's
 * sale paid, nobody writes to the number until Monday, and Meta hears about the sale on
 * Monday — in the wrong attribution window, which is the one thing this whole stage exists
 * to get right. A shop whose ads are paused, or whose customers are asleep, would report
 * nothing at all. The webhook drain stays: a report queued by a delivery goes out in that
 * same tick rather than waiting up to a minute for this.
 *
 * Here in the entrypoint and not in `buildServer`, because every test builds a server and
 * none of them may start a timer that outlives the test and reaches for Meta.
 */
const CAPI_DRAIN_MS = 60_000;
const capiDeps = { capi, key: credentialsKey(env) };
let draining = false;

const capiTimer = setInterval(() => {
  // Meta answering slowly must not stack passes on each other. A tick that finds the
  // previous drain still running does nothing: the work is still there a minute later, and
  // the drain has its own budget for how long one pass may take.
  if (draining) return;
  draining = true;
  void sendPendingCapiEvents(db, capiDeps)
    .catch((error) => {
      app.log.error({ error }, 'capi: scheduled drain failed');
    })
    .finally(() => {
      draining = false;
    });
}, CAPI_DRAIN_MS);

// This file has no graceful shutdown to hang a `clearInterval` on — no signal handler, no
// `app.close()`, nothing else torn down — and inventing one here would be a second decision
// hidden inside this one. `unref` is what makes that safe: the timer never holds the process
// open by itself, so it dies with everything else and cannot delay an exit by up to a minute.
capiTimer.unref();
