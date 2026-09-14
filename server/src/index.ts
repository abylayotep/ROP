import { drainCrmAnalyses } from './lib/crm/worker.js';
import { createLiveCrmHandler, createCrmDeps } from './lib/crm/live.js';
import { runScriptPaymentTurns } from './lib/ai/script-payment.js';
import { reconcileKaspiPayments } from './lib/kaspi/service.js';
import { queueMissingPurchases } from './lib/capi/enqueue.js';
import { reconcileOrphanedRuns } from './api/drafts.js';
import { defaultAutopilotOps, drainAutopilots, type AutopilotDeps } from './lib/drafts/autopilot.js';
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
import { createHistoryArchive } from './lib/whatsapp/linked/history-archive.js';
import { decodeHistoryPayload, downloadHistoryPayload } from './lib/whatsapp/linked/history-codec.js';
import { createModelClient } from './lib/ai/openrouter.js';
import { createGraphClient } from './lib/whatsapp/graph.js';
import { createInstagramMessagingClient } from './lib/instagram/messaging-graph.js';
import { processPendingInstagramEvents } from './lib/instagram/inbound.js';
import { reconcileGenerationRuns } from './lib/knowledge/generation-run.js';

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
const historyArchive = createHistoryArchive(db, credentialsKey(env), {
  download: downloadHistoryPayload,
  decode: decodeHistoryPayload,
  onImported: (numberId, chunk) => linked.report({ type: 'history', numberId, chunk }),
});
const linked = createLinkedClient({ session: createLinkedSocket(db, credentialsKey(env), {
  capture: (numberId, notification) => historyArchive.capture(numberId, notification),
  onError: () => app.log.error('linked: history archive capture failed'),
}) });
const graph = createGraphClient();
const model = createModelClient();
const instagramMessaging = createInstagramMessagingClient();
const app = buildServer(env, db, { capi, linked, graph, model, instagramMessaging });

// Only connection metadata crosses into logs; never log frames, credentials or messages.
linked.on((event) => {
  if (event.type === 'closed') {
    app.log.warn({ numberId: event.numberId, statusCode: event.statusCode ?? null,
      loggedOut: event.loggedOut }, 'linked: connection closed');
  } else if (event.type === 'open') {
    app.log.info({ numberId: event.numberId }, 'linked: connection open');
  }
});

registerLinkedLifecycle(db, credentialsKey(env), linked, {
  onError: (message) => app.log.error({ message }, 'linked: lifecycle'),
});

// The two halves of what a phone's socket produces: live messages, and the chats it
// already had. Registered here rather than in `buildServer` for the same reason the
// lifecycle is — a test that builds a server must not acquire a pipeline that writes.
const liveDeps = { model, graph, linked, key: credentialsKey(env), env, instagramMessaging };
registerLinkedInbound(
  db,
  {
    ...liveDeps,
    crm: createLiveCrmHandler(db, env, liveDeps),
    mediaDir: env.MEDIA_DIR,
    onError: (message) => app.log.error({ message }, 'linked: inbound'),
  },
  linked,
);
registerLinkedHistory(
  db,
  {
    onError: (message) => app.log.error({ message }, 'linked: history'),
    onImported: (report) => app.log.info(report, 'linked: history imported'),
  },
  linked,
);

// Before this process takes a single request — see `api/drafts.ts`'s own comment on why a
// `running` test run left behind by a dead process needs this, and why it runs here rather
// than on a hook every test's own `buildServer` would trip too.
await reconcileOrphanedRuns(db);
await reconcileGenerationRuns(db);
void processPendingInstagramEvents(db, liveDeps)
  .catch((error) => app.log.error({ error }, 'instagram: startup event recovery failed'));

// A pairing is a QR code on somebody's screen, and that screen did not survive the
// restart either. Left in place, one of them refuses every later attempt by that account.
const stalePairings = await clearStalePairings(db);
if (stalePairings > 0) app.log.info({ stalePairings }, 'linked: cleared stale pairings');

await app.listen({ port: env.PORT, host: '0.0.0.0' });

const drainHistoryArchive = () => void historyArchive.drain()
  .catch(() => app.log.error('linked: history archive drain failed'));
drainHistoryArchive();
const historyArchiveTimer = setInterval(drainHistoryArchive, 5_000);
historyArchiveTimer.unref();

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

// CRM catches imported history and operator messages without blocking dialog requests.
let crmRunning = false;
const drainCrm = async () => {
  if (crmRunning) return;
  crmRunning = true;
  try { await drainCrmAnalyses(db,createCrmDeps(db,env,liveDeps)); }
  catch { app.log.error('crm: background analysis failed'); }
  finally { crmRunning = false; }
};
void drainCrm();
const crmTimer = setInterval(() => void drainCrm(),5_000);
crmTimer.unref();
// Draft autopilots advance one step per pass; the row is the whole state, so a pass that dies
// with the process resumes on the next boot. Started after `reconcileOrphanedRuns`, which turns
// the runs a dead process left `running` into `failed` rows the engine restarts.
let autopilotRunning = false;
const autopilotDeps: AutopilotDeps = {
  db,
  deps: liveDeps,
  key: credentialsKey(env),
  log: (obj, msg) => app.log.error(obj, msg),
  ops: defaultAutopilotOps,
};
const drainAutopilot = async () => {
  if (autopilotRunning) return;
  autopilotRunning = true;
  try { await drainAutopilots(autopilotDeps); }
  catch (error) { app.log.error({ error }, 'draft autopilot: drain failed'); }
  finally { autopilotRunning = false; }
};
const autopilotTimer = setInterval(() => void drainAutopilot(), 5_000);
autopilotTimer.unref();

// The reply a confirmed payment starts when the sales script waits for it. On its own clock
// rather than inside the two paths that mark an order paid — see `lib/ai/script-payment.ts`.
// `crm` is set as the live CRM reply sets it, so in production a payment turn leaves the stage
// and fields to the CRM worker exactly as a customer's turn does.
let paymentTurnsRunning = false;
const runPaymentTurns = async () => {
  if (paymentTurnsRunning) return;
  paymentTurnsRunning = true;
  try { await runScriptPaymentTurns(db, { ...liveDeps, crm: async () => true }); }
  catch { app.log.error('script: payment turns failed'); }
  finally { paymentTurnsRunning = false; }
};
const paymentTurnsTimer = setInterval(() => void runPaymentTurns(), 5_000);
paymentTurnsTimer.unref();
let kaspiRunning = false;
const reconcilePayments = async () => {
  if (kaspiRunning) return;
  kaspiRunning = true;
  try { await reconcileKaspiPayments(db,env); }
  catch { app.log.error('kaspi: reconciliation failed'); }
  finally { kaspiRunning = false; }
};
void reconcilePayments();
const kaspiTimer = setInterval(() => void reconcilePayments(),5_000);
kaspiTimer.unref();
// Chat-paid orders have no Kaspi row, so their lost purchases are recovered on their own,
// slower clock: a lost report is rare, and the sweep reads every tenant's recent orders.
let purchaseRecoveryRunning = false;
const recoverPurchases = async () => {
  if (purchaseRecoveryRunning) return;
  purchaseRecoveryRunning = true;
  try {
    const missing = await queueMissingPurchases(db);
    if (missing.length > 0) app.log.warn({ count: missing.length, orderIds: missing }, 'capi: paid orders still without a purchase after recovery');
  }
  catch { app.log.error('capi: purchase recovery failed'); }
  finally { purchaseRecoveryRunning = false; }
};
void recoverPurchases();
const purchaseRecoveryTimer = setInterval(() => void recoverPurchases(),60_000);
purchaseRecoveryTimer.unref();
