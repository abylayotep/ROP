/**
 * Демо-сервер для разработки интерфейса.
 *
 *   npm run mock        # http://localhost:8787
 *
 * Отдаёт те же эндпоинты, что и настоящий бэкенд, на вымышленных данных из
 * fixtures/. В приложение эти данные не попадают: в src/ их нет вообще, и
 * собранный бандл про них не знает. Нужен, чтобы можно было работать над
 * экранами, пока бэкенд на VPS ещё не готов.
 *
 * Подключение: VITE_API_PROXY=http://localhost:8787 в .env.local.
 */
import { createServer } from 'node:http';
import { adAccounts, syncModes, whatsappNumbers, whatsappPending } from './fixtures/accounts.mjs';
import { activity } from './fixtures/activity.mjs';
import { segments, templates, broadcastHistory } from './fixtures/broadcast.mjs';
import { creatives, adsMeta } from './fixtures/creatives.mjs';
import { dialogs } from './fixtures/dialogs.mjs';
import { sellers } from './fixtures/sellers.mjs';
import {
  agentConfig,
  benchmarks,
  broadcastQuality,
  capiReconciliation,
  insights,
  integrations,
  periodSummary,
  profile,
  sellersSummary,
} from './fixtures/extra.mjs';

const PORT = Number(process.env.PORT ?? 8787);

/** Состояние, которое меняется запросами: живёт в памяти до перезапуска. */
const state = {
  settings: {
    selectedAccounts: ['act_1', 'act_2', 'act_3'],
    syncMode: syncModes[0],
  },
  agent: structuredClone(agentConfig),
  /** Статусы объявлений, изменённые тумблерами. */
  adStatus: {},
  numbers: structuredClone(whatsappNumbers),
  qrSessions: new Map(),
};

const routes = [];
const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

function withStatus(list) {
  return list.map((c) => c);
}

/** Показатели Ads Manager с учётом изменённых тумблерами статусов. */
function insightsWithStatus() {
  const out = {};
  for (const [key, value] of Object.entries(adsMeta)) {
    out[key] = { ...value, status: state.adStatus[key] ?? value.status };
  }
  return out;
}

// ── Профиль и настройки ──────────────────────────────────────────────────────

on('GET', /^\/api\/profile$/, () => profile);

on('GET', /^\/api\/settings$/, () => state.settings);
on('PATCH', /^\/api\/settings$/, (_m, _q, body) => {
  Object.assign(state.settings, body);
  return state.settings;
});

// ── Реклама ──────────────────────────────────────────────────────────────────

on('GET', /^\/api\/ad-accounts$/, () => adAccounts);
on('GET', /^\/api\/creatives$/, () => withStatus(creatives));
on('GET', /^\/api\/ads\/insights$/, () => insightsWithStatus());

on('PATCH', /^\/api\/ads\/(.+)$/, (m, _q, body) => {
  const id = decodeURIComponent(m[1]);
  state.adStatus[id] = body.status === 'ACTIVE' ? (adsMeta[id]?.status ?? 'active') : 'off';
  if (body.status === 'ACTIVE' && state.adStatus[id] === 'off') state.adStatus[id] = 'active';
  return { ok: true };
});

on('POST', /^\/api\/ads\/bulk$/, (_m, _q, body) => {
  const { adIds = [], action } = body;
  if (action === 'pause') adIds.forEach((id) => (state.adStatus[id] = 'off'));
  if (action === 'activate')
    adIds.forEach((id) => (state.adStatus[id] = adsMeta[id]?.status ?? 'active'));
  return { ok: true, affected: adIds.length };
});

// ── Сводка периода ───────────────────────────────────────────────────────────

on('GET', /^\/api\/overview$/, () => ({ insights, summary: periodSummary }));
on('GET', /^\/api\/benchmarks$/, () => benchmarks);
on('GET', /^\/api\/capi\/reconciliation$/, () => capiReconciliation);

// ── Диалоги ──────────────────────────────────────────────────────────────────

on('GET', /^\/api\/dialogs$/, (_m, q) => {
  const outcome = q.get('outcome');
  const creative = q.get('creative');
  const search = (q.get('q') ?? '').trim().toLowerCase();

  return dialogs.filter((d) => {
    if (outcome === 'buy' && !d.status.startsWith('Купи')) return false;
    if (outcome === 'lost' && d.status !== 'Упустили') return false;
    if (outcome === 'work' && d.status !== 'В работе') return false;
    if (creative && d.creative !== creative) return false;
    if (
      search &&
      ![d.client, d.city, d.ask, d.seller, d.creative, d.campaign].some((f) =>
        f.toLowerCase().includes(search)
      )
    )
      return false;
    return true;
  });
});

on('POST', /^\/api\/dialogs\/([^/]+)\/reanalyze$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const found = dialogs.find((d) => d.id === id);
  if (!found) return { status: 404, body: { message: 'Диалог не найден' } };
  return found;
});

// ── Продавцы ─────────────────────────────────────────────────────────────────

on('GET', /^\/api\/sellers$/, () => ({ sellers, summary: sellersSummary }));
on('GET', /^\/api\/sellers\/activity$/, () => activity);

// ── Рассылки ─────────────────────────────────────────────────────────────────

on('GET', /^\/api\/broadcast\/config$/, () => ({
  segments,
  templates,
  history: broadcastHistory,
  quality: broadcastQuality,
}));

on('POST', /^\/api\/broadcast$/, (_m, _q, body) => {
  const chosen = segments.filter((s) => (body.segmentIds ?? []).includes(s.id));
  if (chosen.some((s) => s.forbidden)) {
    return { status: 422, body: { message: 'В выборке есть база без согласия на переписку' } };
  }
  return { queued: chosen.reduce((a, s) => a + s.optIn, 0) };
});

// ── WhatsApp ─────────────────────────────────────────────────────────────────

on('GET', /^\/api\/whatsapp\/numbers$/, () => state.numbers);

on('POST', /^\/api\/whatsapp\/qr$/, () => {
  const sessionId = `qr_${Math.random().toString(36).slice(2, 10)}`;
  state.qrSessions.set(sessionId, { createdAt: Date.now() });
  return { sessionId, payload: sessionId, expiresInSeconds: 60 };
});

on('GET', /^\/api\/whatsapp\/qr\/([^/]+)$/, (m) => {
  const id = decodeURIComponent(m[1]);
  const session = state.qrSessions.get(id);
  if (!session) return { state: 'expired' };
  // Демонстрируем подтверждение через восемь секунд ожидания.
  if (Date.now() - session.createdAt > 8000) {
    state.qrSessions.delete(id);
    if (!state.numbers.some((n) => n.phone === whatsappPending.phone)) {
      state.numbers = [...state.numbers, whatsappPending];
    }
    return { state: 'linked', number: whatsappPending };
  }
  return { state: 'waiting' };
});

on('DELETE', /^\/api\/whatsapp\/qr\/([^/]+)$/, (m) => {
  state.qrSessions.delete(decodeURIComponent(m[1]));
  return { ok: true };
});

on('DELETE', /^\/api\/whatsapp\/numbers\/([^/]+)$/, (m) => {
  const phone = decodeURIComponent(m[1]);
  state.numbers = state.numbers.filter((n) => n.phone !== phone);
  return { ok: true };
});

// ── Интеграции и агент ───────────────────────────────────────────────────────

on('GET', /^\/api\/integrations$/, () => integrations);

on('GET', /^\/api\/agent$/, () => state.agent);
on('PATCH', /^\/api\/agent$/, (_m, _q, body) => {
  if (typeof body.enabled === 'boolean') state.agent.enabled = body.enabled;
  if (body.rule) {
    const rule = state.agent.rules.find((r) => r.id === body.rule.id);
    if (rule) rule.enabled = body.rule.enabled;
  }
  return state.agent;
});

// ── Сервер ───────────────────────────────────────────────────────────────────

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  let body;
  if (req.method !== 'GET') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
  }

  const route = routes.find(
    (r) => r.method === req.method && r.pattern.test(url.pathname)
  );

  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: `Нет обработчика для ${req.method} ${url.pathname}` }));
    return;
  }

  const match = url.pathname.match(route.pattern);
  let result;
  try {
    result = await route.handler(match, url.searchParams, body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: String(e?.message ?? e) }));
    return;
  }

  // Обработчик может вернуть { status, body } — так отдаются ошибки.
  const status = result && typeof result === 'object' && 'status' in result ? result.status : 200;
  const payload = status === 200 ? result : result.body;

  // Небольшая задержка, чтобы состояния загрузки были видны как в бою.
  await new Promise((r) => setTimeout(r, 120));

  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}).listen(PORT, () => {
  console.log(`Демо-сервер «Ракурс» слушает http://localhost:${PORT}`);
  console.log('В .env.local укажите VITE_API_PROXY=http://localhost:' + PORT);
});
