import { reconcileOrphanedRuns } from './api/drafts.js';
import { buildServer } from './api/server.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';
import { createCapiClient } from './lib/capi/client.js';
import { sendPendingCapiEvents } from './lib/capi/queue.js';
import { credentialsKey } from './lib/secret-box.js';
import { createLinkedClient } from './lib/whatsapp/linked/client.js';
import { registerLinkedHistory } from './lib/whatsapp/linked/history.js';
import { registerLinkedInbound } from './lib/whatsapp/linked/inbound.js';
import {
  clearStalePairings,
  registerLinkedLifecycle,
  restoreLinkedSessions,
} from './lib/whatsapp/linked/lifecycle.js';
import { createLinkedSocket } from './lib/whatsapp/linked/socket.js';
import { createModelClient } from './lib/ai/openrouter.js';
import { createGraphClient } from './lib/whatsapp/graph.js';

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
// Built here for the same reason, plus one of its own: the lifecycle below reconnects
// dropped phones on a timer, and no test may start a timer that outlives it and reaches
// for WhatsApp.
const linked = createLinkedClient({ session: createLinkedSocket(db, credentialsKey(env)) });
const app = buildServer(env, db, { capi, linked });

registerLinkedLifecycle(db, credentialsKey(env), linked, {
  onError: (message) => app.log.error({ message }, 'linked: lifecycle'),
});

// The two halves of what a phone's socket produces: live messages, and the chats it
// already had. Registered here rather than in `buildServer` for the same reason the
// lifecycle is — a test that builds a server must not acquire a pipeline that writes.
registerLinkedInbound(
  db,
  {
    model: createModelClient(),
    graph: createGraphClient(),
    linked,
    key: credentialsKey(env),
    mediaDir: env.MEDIA_DIR,
    onError: (message) => app.log.error({ message }, 'linked: inbound'),
  },
  linked,
);
registerLinkedHistory(
  db,
  { onError: (message) => app.log.error({ message }, 'linked: history') },
  linked,
);

// Before this process takes a single request — see `api/drafts.ts`'s own comment on why a
// `running` test run left behind by a dead process needs this, and why it runs here rather
// than on a hook every test's own `buildServer` would trip too.
await reconcileOrphanedRuns(db);

// A pairing is a QR code on somebody's screen, and that screen did not survive the
// restart either. Left in place, one of them refuses every later attempt by that account.
const stalePairings = await clearStalePairings(db);
if (stalePairings > 0) app.log.info({ stalePairings }, 'linked: cleared stale pairings');

await app.listen({ port: env.PORT, host: '0.0.0.0' });

// After `listen`, deliberately: the cabinet must answer HTTP before it waits on handsets,
// and a phone that is switched off must not delay every other client's first request.
void restoreLinkedSessions(db, linked, (message) =>
  app.log.error({ message }, 'linked: restore'),
);

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
