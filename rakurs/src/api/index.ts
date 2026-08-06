import type {
  AdAccount,
  AdMeta,
  AgentConfig,
  Benchmarks,
  BroadcastHistoryRow,
  BroadcastSegment,
  BroadcastTemplate,
  Creative,
  DayActivity,
  DayKey,
  Dialog,
  DialogFilter,
  Insight,
  IntegrationStatus,
  Period,
  PeriodSummary,
  Profile,
  Seller,
  SellersSummary,
  Settings,
  WhatsAppNumber,
} from '@/types';
import { periodDays, request } from './client';

export { API_URL, ApiError, humanError, request } from './client';

/**
 * Все обращения к бэкенду. Токены Meta, amoCRM и WhatsApp живут только там:
 * в браузер они не попадают, фронт ходит на свой /api.
 */

// ── Профиль и настройки ──────────────────────────────────────────────────────

/** GET /api/profile — название проекта, тариф, валюта отчётов. */
export const getProfile = (signal?: AbortSignal) => request<Profile>('/profile', { signal });

export type { Settings };

export const getSettings = (signal?: AbortSignal) => request<Settings>('/settings', { signal });

/** PATCH /api/settings — частичное обновление, приходит по каждому переключателю. */
export const updateSettings = (patch: Partial<Settings>) =>
  request<Settings>('/settings', { method: 'PATCH', body: patch });

// ── Реклама ──────────────────────────────────────────────────────────────────

/** GET /api/ad-accounts */
export const listAccounts = (signal?: AbortSignal) =>
  request<AdAccount[]>('/ad-accounts', { signal });

/**
 * GET /api/creatives?days=30
 *
 * Объявления с расходом из Meta и выручкой из CRM в одной строке — главная
 * таблица продукта. Отдаются все подключённые аккаунты сразу: галочки на экране
 * интеграций фильтруют уже загруженное, переключение должно быть мгновенным.
 */
export const listCreatives = (period: Period, signal?: AbortSignal) =>
  request<Creative[]>('/creatives', { query: { days: periodDays(period) }, signal });

/** GET /api/ads/insights?days=30 — показатели Ads Manager, ключ равен названию креатива. */
export const listAdInsights = (period: Period, signal?: AbortSignal) =>
  request<Record<string, AdMeta>>('/ads/insights', { query: { days: periodDays(period) }, signal });

/** PATCH /api/ads/:id — включение и выключение объявления в Meta. */
export const setAdStatus = (adId: string, active: boolean) =>
  request<void>(`/ads/${encodeURIComponent(adId)}`, {
    method: 'PATCH',
    body: { status: active ? 'ACTIVE' : 'PAUSED' },
  });

/** POST /api/ads/bulk — массовые действия над выделенными строками. */
export const bulkAdAction = (adIds: string[], action: 'pause' | 'activate' | 'duplicate') =>
  request<void>('/ads/bulk', { method: 'POST', body: { adIds, action } });

// ── Сводка периода ───────────────────────────────────────────────────────────

/**
 * GET /api/overview?days=30 — автоматические выводы «где теряем деньги» и
 * показатели, которые не выводятся из таблицы объявлений: динамика к прошлому
 * периоду, сколько упущенных были готовы купить, срок от заявки до оплаты.
 */
export const getOverview = (period: Period, signal?: AbortSignal) =>
  request<{ insights: Insight[]; summary: PeriodSummary }>('/overview', {
    query: { days: periodDays(period) },
    signal,
  });

/** GET /api/benchmarks?days=30 — средние по отделу для сравнения в разборе. */
export const getBenchmarks = (period: Period, signal?: AbortSignal) =>
  request<Benchmarks>('/benchmarks', { query: { days: periodDays(period) }, signal });

export interface CapiReconciliation {
  acceptedFromCrm: number;
  sentToMeta: number;
  confirmedByMeta: number;
  pending: number;
  needsReview: number;
  /** Event Match Quality, 0–10: насколько хорошо Meta сопоставила события с людьми. */
  emq: number;
}

/**
 * GET /api/capi/reconciliation?days=7
 *
 * Сверка Conversions API: оплаты из CRM уходят обратно в Meta с суммой чека,
 * и алгоритм оптимизируется на покупателей. Событие отправляет бэкенд по
 * вебхуку от CRM — он же хэширует телефон и e-mail в SHA-256.
 */
export const getCapiReconciliation = (period: Period, signal?: AbortSignal) =>
  request<CapiReconciliation>('/capi/reconciliation', {
    query: { days: periodDays(period) },
    signal,
  });

// ── Диалоги ──────────────────────────────────────────────────────────────────

export interface DialogQuery {
  period: Period;
  filter?: DialogFilter;
  creative?: string | null;
  search?: string;
}

/**
 * GET /api/dialogs?days=30&outcome=lost&creative=…&q=…
 *
 * Сообщения приходят из WhatsApp Business API и Instagram Messaging API, поля
 * разбора считает модель на бэкенде. Разбор кешируется и обновляется по
 * расписанию: гонять модель на каждый просмотр списка дорого и незачем.
 */
export const listDialogs = (q: DialogQuery, signal?: AbortSignal) =>
  request<Dialog[]>('/dialogs', {
    query: {
      days: periodDays(q.period),
      outcome: q.filter && q.filter !== 'all' ? q.filter : undefined,
      creative: q.creative ?? undefined,
      q: q.search || undefined,
    },
    signal,
  });

/** POST /api/dialogs/:id/reanalyze — принудительно пересчитать разбор. */
export const reanalyzeDialog = (id: string) =>
  request<Dialog>(`/dialogs/${encodeURIComponent(id)}/reanalyze`, { method: 'POST' });

// ── Продавцы ─────────────────────────────────────────────────────────────────

/** GET /api/sellers?days=30 — рейтинг и сводка по отделу. */
export const listSellers = (period: Period, signal?: AbortSignal) =>
  request<{ sellers: Seller[]; summary: SellersSummary }>('/sellers', {
    query: { days: periodDays(period) },
    signal,
  });

/**
 * GET /api/sellers/activity?days=30 — обращения клиентов и сообщения продавцов
 * по часам и дням недели. Отсюда видно часы, когда клиенты пишут, а на линии
 * никого нет: главный источник потерь.
 */
export const getActivity = (period: Period, signal?: AbortSignal) =>
  request<Record<DayKey, DayActivity>>('/sellers/activity', {
    query: { days: periodDays(period) },
    signal,
  });

// ── Рассылки ─────────────────────────────────────────────────────────────────

export interface BroadcastConfig {
  segments: BroadcastSegment[];
  templates: BroadcastTemplate[];
  history: BroadcastHistoryRow[];
  /** Качество номера и лимиты портфеля из WhatsApp Manager. */
  quality: {
    rating: 'green' | 'yellow' | 'red';
    blockRate: number;
    tierLimit: number;
    sentToday: number;
    openWindows: number;
    optedOut: number;
  };
}

/** GET /api/broadcast/config — сегменты, шаблоны, история и лимиты одним запросом. */
export const getBroadcastConfig = (signal?: AbortSignal) =>
  request<BroadcastConfig>('/broadcast/config', { signal });

export interface StartBroadcastRequest {
  segmentIds: string[];
  templateId: string;
  pace: 'ramp' | 'even' | 'blast';
  window: string;
}

/**
 * POST /api/broadcast — запуск.
 *
 * Правила предполётной проверки обязаны стоять и на сервере: без согласия на
 * переписку, при превышении лимита двух маркетинговых сообщений в сутки на
 * человека (ошибка 131049) или при залповой отправке Meta блокирует номер.
 * Кнопка в интерфейсе — удобство, а не защита.
 */
export const startBroadcast = (req: StartBroadcastRequest) =>
  request<{ queued: number }>('/broadcast', { method: 'POST', body: req });

// ── WhatsApp ─────────────────────────────────────────────────────────────────

export const listNumbers = (signal?: AbortSignal) =>
  request<WhatsAppNumber[]>('/whatsapp/numbers', { signal });

export interface QrSession {
  sessionId: string;
  /** Строка, которую надо закодировать в QR. */
  payload: string;
  expiresInSeconds: number;
}

export type QrStatus =
  | { state: 'waiting' }
  | { state: 'expired' }
  | { state: 'linked'; number: WhatsAppNumber };

/** POST /api/whatsapp/qr — сессия привязки устройства. */
export const createQrSession = () => request<QrSession>('/whatsapp/qr', { method: 'POST' });

/**
 * GET /api/whatsapp/qr/:id — статус привязки. Экран опрашивает его, пока панель
 * открыта; в бою это можно заменить на WebSocket, интерфейс не изменится.
 */
export const getQrStatus = (sessionId: string) =>
  request<QrStatus>(`/whatsapp/qr/${encodeURIComponent(sessionId)}`);

export const cancelQrSession = (sessionId: string) =>
  request<void>(`/whatsapp/qr/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });

/** DELETE /api/whatsapp/numbers/:phone — отключить номер от разбора. */
export const disconnectNumber = (phone: string) =>
  request<void>(`/whatsapp/numbers/${encodeURIComponent(phone)}`, { method: 'DELETE' });

// ── Интеграции и агент ───────────────────────────────────────────────────────

export const listIntegrations = (signal?: AbortSignal) =>
  request<IntegrationStatus[]>('/integrations', { signal });

/** GET /api/agent — база знаний, правила, тайминги, примеры ответов. */
export const getAgent = (signal?: AbortSignal) => request<AgentConfig>('/agent', { signal });

/** PATCH /api/agent — режим работы и отдельные правила. */
export const updateAgent = (patch: { enabled?: boolean; rule?: { id: string; enabled: boolean } }) =>
  request<AgentConfig>('/agent', { method: 'PATCH', body: patch });
