/** Доменные типы «Ракурса». Ровно те формы, которые отдаёт бэкенд. */

// ── Диалоги ────────────────────────────────────────────────────────────────

export type DialogStatus = 'Купил' | 'Купила' | 'Упустили' | 'В работе';

export interface ChatMessage {
  who: 'client' | 'seller';
  time: string;
  text: string;
  /** Что продавец приложил к сообщению: фото, прайс, расчёт. */
  attach?: string[];
  /** Плашка «столько-то без ответа» перед сообщением. */
  gap?: string;
}

export interface Dialog {
  id: string;
  client: string;
  city: string;
  channel: string;
  time: string;
  campaign: string;
  group: string;
  creative: string;
  /** Запрос клиента одной фразой — результат разбора модели. */
  ask: string;
  sent: string[];
  forWhom: string;
  purpose: string;
  seller: string;
  status: DialogStatus;
  amount: number;
  /** Оценка работы продавца в этом диалоге, 0–100. */
  score: number;
  outcomeTitle: string;
  outcome: string;
  draft: string;
  draftMeta: string;
  capiTitle: string;
  capiMeta: string;
  chat: ChatMessage[];
}

// ── Креативы и объявления ──────────────────────────────────────────────────

export type Verdict = 'good' | 'warn' | 'bad';

export interface LabeledCount {
  label: string;
  count: string;
  /** Цвет значения — для потерь: критичные красным, нейтральные приглушённым. */
  color?: string;
}

export interface Creative {
  creative: string;
  /** Название кампании, к которой относится объявление. */
  name: string;
  audience: string;
  placement: string;
  account: string;
  spendUsd: number;
  spendKzt: number;
  dialogs: number;
  qual: number;
  measure: number;
  purchases: number;
  revenue: number;
  /** Сколько покупок реально ушло в Meta через CAPI. */
  sentToMeta: number;
  verdict: Verdict;
  verdictLabel: string;
  verdictText: string;
  asks: LabeledCount[];
  losses: LabeledCount[];
  capiTitle: string;
  capiMeta: string;
}

export type DeliveryStatus = 'active' | 'learning' | 'review' | 'off';

/** Показатели из Ads Manager по объявлению — то, что отдаёт Meta Marketing API. */
export interface AdMeta {
  adset: string;
  objective: string;
  format: string;
  status: DeliveryStatus;
  impressions: number;
  clicks: number;
  /** «Результаты» в терминах Meta — переписка или заявка, не оплата. */
  metaResults: number;
  metaPurch: number;
  freq: string;
  emq: string;
}

// ── Продавцы и загрузка ────────────────────────────────────────────────────

export interface Seller {
  initials: string;
  name: string;
  dialogs: string;
  sales: string;
  conv: string;
  reply: string;
  /** Оценка AI, 0–100 — от неё зависит цвет полосы. */
  score: number;
  fix: string;
  /** Числовые значения для окраски: конверсия в % и время ответа в минутах. */
  convValue: number;
  replyMinutes: number;
}

export type DayKey = 'Пн' | 'Вт' | 'Ср' | 'Чт' | 'Пт' | 'Сб' | 'Вс';

export interface DayActivity {
  /** Обращения клиентов по часам, 16 значений — 8:00…23:00. */
  incoming: number[];
  /** Сообщения продавца по часам, ключ — инициалы. */
  sellers: Record<string, number[]>;
}

// ── Рекламные аккаунты ─────────────────────────────────────────────────────

export interface AdAccount {
  id: string;
  num: string;
  name: string;
  currency: string;
  creatives: number;
  status: string;
  statusFg: string;
  /** Расход за 30 дней, если он не выводится из видимых креативов. */
  spendOverride?: string;
}

// ── Рассылки ───────────────────────────────────────────────────────────────

export interface BroadcastSegment {
  id: string;
  label: string;
  meta: string;
  total: number;
  optIn: number;
  stopped: number;
  capped: number;
  /** Номера +1 — для них marketing-шаблоны недоступны. */
  us: number;
  forbidden?: boolean;
}

export type TemplateCategory = 'marketing' | 'utility';

export interface BroadcastTemplate {
  id: string;
  cat: TemplateCategory;
  name: string;
  quality: string;
  ok: boolean;
  warn?: boolean;
  body: string;
  footer: string;
}

export interface PaceOption {
  id: 'ramp' | 'even' | 'blast';
  label: string;
  meta: string;
  risk: string;
  ok: boolean;
}

export interface BroadcastHistoryRow {
  name: string;
  date: string;
  cat: string;
  sent: string;
  read: string;
  replied: string;
  blocked: string;
  blockFg: string;
  sales: string;
  quality: string;
  qDot: string;
  qFg: string;
}

// ── WhatsApp ───────────────────────────────────────────────────────────────

export interface WhatsAppNumber {
  phone: string;
  owner: string;
  dialogs: string;
  status: string;
  statusFg: string;
  dot: string;
  since: string;
  action: string;
}

// ── Общее ──────────────────────────────────────────────────────────────────

export type TabId =
  | 'overview'
  | 'dialogs'
  | 'sellers'
  | 'sources'
  | 'broadcast'
  | 'agent'
  | 'settings';

export type Theme = 'light' | 'dark';
export type Period = '7д' | '30д' | '90д';
export type DialogFilter = 'all' | 'buy' | 'lost' | 'work';
export type CreativeLevel = 'campaign' | 'adset' | 'ad';
export type ColumnSet = 'crm' | 'meta' | 'match';

// ── Данные, которые считает бэкенд ─────────────────────────────────────────

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface Profile {
  projectName: string;
  planLine: string;
  currency: string;
  updatedMinutesAgo: number;
  /** Курс для пересчёта расхода в доллары на экране креативов. */
  usdRate: number;
  user: { initials: string };
}

/** Куда ведёт кнопка вывода: экран и фильтр, который надо применить. */
export interface InsightTarget {
  screen: 'dialogs' | 'sellers' | 'creative' | 'broadcast';
  filter?: DialogFilter;
  creative?: string;
}

export interface Insight {
  tone: Tone;
  title: string;
  meta: string;
  action: string;
  target: InsightTarget;
}

export interface PeriodSummary {
  revenueDeltaPct: number;
  lostReadyToBuy: number;
  roasDelta: number;
  cpaDeltaPct: number;
  crmToPaymentDays: number;
}

/** Средние по отделу — база для сравнения в разборе объявления. */
export interface Benchmarks {
  cpa: number;
  averageCheck: number;
  dialogToBuyPct: number;
}

export interface SellersSummary {
  avgReplyMinutes: number;
  bestReplyMinutes: number;
  conversionGap: number;
}

export interface IntegrationStatus {
  name: string;
  state: Tone;
  status: string;
  description: string;
  rows: { k: string; v: string }[];
}

export interface AgentRule {
  id: string;
  enabled: boolean;
  title: string;
  meta: string;
}

export interface TrainingSource {
  id: string;
  label: string;
  meta: string;
  state: Tone;
  status: string;
  action: string;
  target?: InsightTarget;
}

export interface AgentMessage {
  who: string;
  time: string;
  text: string;
  attach?: string[];
  mine: boolean;
}

export interface AgentConfig {
  enabled: boolean;
  name: string;
  tagline: string;
  trainedOnDialogs: number;
  lastTrainedAt: string;
  trainingUpdatedAt: string;
  retrainHint: string;
  rules: AgentRule[];
  scheduleSummary: string;
  timezone: string;
  trainingSources: TrainingSource[];
  patterns: { trigger: string; stat: string; answer: string }[];
  stats: { label: string; value: string; sub: string; tone: Tone }[];
  forbidden: string[];
  tone: { label: string; value: string; w: string }[];
  timings: { label: string; value: string; hint: string }[];
  escalations: string[];
  testChat: AgentMessage[];
  rejected: { text: string; reason: string }[];
}

// ── Settings ───────────────────────────────────────────────────────────────

export interface Settings {
  /** Selected ad accounts — campaigns and creatives come from these. */
  selectedAccounts: string[];
  syncMode: string;
}
