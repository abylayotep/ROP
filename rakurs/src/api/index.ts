import type {
  Agent,
  AiModel,
  AiSettings,
  AiTurn,
  AiUsage,
  AiUsagePeriod,
  Board,
  CapiEvent,
  CapiSettings,
  ConversationSummary,
  ConversationThread,
  Customer,
  KbImport,
  KbItem,
  KbItemKind,
  KbSource,
  Lead,
  LeadField,
  Me,
  Member,
  Message,
  Stage,
  StatsCurrent,
  WebhookSetup,
  WhatsappNumber,
} from '@/types';
import { API_URL, LONG_TIMEOUT_MS, request } from './client';

export { API_URL, ApiError, humanError, request } from './client';

/**
 * Every call the cabinet makes. Meta and WhatsApp credentials live on the server only:
 * the browser talks to our own /api and never to a vendor directly.
 */

// ── Session ──────────────────────────────────────────────────────────────────

export const getMe = (signal?: AbortSignal) => request<Me>('/auth/me', { signal });

export const login = (email: string, password: string) =>
  request<Me>('/auth/login', { method: 'POST', body: { email, password } });

export const logout = () => request<{ ok: true }>('/auth/logout', { method: 'POST' });

// ── Agents ───────────────────────────────────────────────────────────────────

export const listAgents = (accountId: string, signal?: AbortSignal) =>
  request<Agent[]>(`/accounts/${accountId}/agents`, { signal });

export const createAgent = (
  accountId: string,
  body: { name: string; description: string; timezone: string },
) => request<Agent>(`/accounts/${accountId}/agents`, { method: 'POST', body });

export const getAgent = (agentId: string, signal?: AbortSignal) =>
  request<Agent>(`/agents/${agentId}`, { signal });

export const updateAgent = (
  agentId: string,
  body: { name?: string; description?: string; timezone?: string },
) => request<Agent>(`/agents/${agentId}`, { method: 'PATCH', body });

// ── WhatsApp ─────────────────────────────────────────────────────────────────

export const listWhatsappNumbers = (agentId: string, signal?: AbortSignal) =>
  request<WhatsappNumber[]>(`/agents/${agentId}/whatsapp/numbers`, { signal });

export const connectWhatsappNumber = (
  agentId: string,
  body: { phoneNumberId: string; wabaId: string; accessToken: string },
) => request<WhatsappNumber>(`/agents/${agentId}/whatsapp/numbers`, { method: 'POST', body });

export const setWhatsappNumberEnabled = (agentId: string, numberId: string, enabled: boolean) =>
  request<WhatsappNumber>(`/agents/${agentId}/whatsapp/numbers/${numberId}`, {
    method: 'PATCH',
    body: { enabled },
  });

/**
 * Заменить токен, не теряя переписки.
 *
 * Удаление номера уносит с собой все диалоги и данные о рекламе, из которой пришли
 * клиенты, а Meta их второй раз не отдаст. Поэтому протухший токен меняется здесь.
 */
export const replaceWhatsappToken = (agentId: string, numberId: string, accessToken: string) =>
  request<WhatsappNumber>(`/agents/${agentId}/whatsapp/numbers/${numberId}`, {
    method: 'PATCH',
    body: { accessToken },
  });

export const disconnectWhatsappNumber = (agentId: string, numberId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/whatsapp/numbers/${numberId}`, { method: 'DELETE' });

export const getWebhookSetup = (agentId: string, signal?: AbortSignal) =>
  request<WebhookSetup>(`/agents/${agentId}/whatsapp/setup`, { signal });

// ── Диалоги ──────────────────────────────────────────────────────────────────

export const listConversations = (agentId: string, signal?: AbortSignal) =>
  request<ConversationSummary[]>(`/agents/${agentId}/conversations`, { signal });

export const getConversation = (agentId: string, conversationId: string, signal?: AbortSignal) =>
  request<ConversationThread>(`/agents/${agentId}/conversations/${conversationId}`, { signal });

export const sendMessage = (agentId: string, conversationId: string, body: string) =>
  request<Message>(`/agents/${agentId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { body },
  });

/** The address of a file inside a message. Access is checked by the session cookie. */
export const mediaUrl = (agentId: string, messageId: string) =>
  `${API_URL}/agents/${agentId}/messages/${messageId}/media`;

// ── Воронка ──────────────────────────────────────────────────────────────────

export const getBoard = (agentId: string, signal?: AbortSignal) =>
  request<Board>(`/agents/${agentId}/board`, { signal });

export const listCustomers = (agentId: string, signal?: AbortSignal) =>
  request<Customer[]>(`/agents/${agentId}/customers`, { signal });

/** Адрес выгрузки. Доступ проверяется той же сессионной кукой, что и всё остальное. */
export const customersCsvUrl = (agentId: string) => `${API_URL}/agents/${agentId}/customers.csv`;

export const listStages = (agentId: string, signal?: AbortSignal) =>
  request<Stage[]>(`/agents/${agentId}/stages`, { signal });

export const createStage = (
  agentId: string,
  body: { name: string; color: string; kind: Stage['kind'] },
) => request<Stage>(`/agents/${agentId}/stages`, { method: 'POST', body });

export const updateStage = (
  agentId: string,
  stageId: string,
  body: Partial<Pick<Stage, 'name' | 'color' | 'kind' | 'description' | 'autoMessage'>>,
) => request<Stage>(`/agents/${agentId}/stages/${stageId}`, { method: 'PATCH', body });

export const deleteStage = (agentId: string, stageId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/stages/${stageId}`, { method: 'DELETE' });

export const reorderStages = (agentId: string, ids: string[]) =>
  request<Stage[]>(`/agents/${agentId}/stages/order`, { method: 'POST', body: { ids } });

export const listLeadFields = (agentId: string, signal?: AbortSignal) =>
  request<LeadField[]>(`/agents/${agentId}/lead-fields`, { signal });

export const createLeadField = (
  agentId: string,
  body: { name: string; kind: LeadField['kind']; hint: string },
) => request<LeadField>(`/agents/${agentId}/lead-fields`, { method: 'POST', body });

/** Переименование поля сохраняет ответы лидов: удаление — единственное, что их уносит. */
export const updateLeadField = (
  agentId: string,
  fieldId: string,
  body: Partial<Pick<LeadField, 'name' | 'kind' | 'hint'>>,
) => request<LeadField>(`/agents/${agentId}/lead-fields/${fieldId}`, { method: 'PATCH', body });

export const deleteLeadField = (agentId: string, fieldId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/lead-fields/${fieldId}`, { method: 'DELETE' });

export const reorderLeadFields = (agentId: string, ids: string[]) =>
  request<LeadField[]>(`/agents/${agentId}/lead-fields/order`, {
    method: 'POST',
    body: { ids },
  });

export const listMembers = (agentId: string, signal?: AbortSignal) =>
  request<Member[]>(`/agents/${agentId}/members`, { signal });

// ── Карточка лида ────────────────────────────────────────────────────────────

const leadPath = (agentId: string, conversationId: string) =>
  `/agents/${agentId}/conversations/${conversationId}/lead`;

export const getLead = (agentId: string, conversationId: string, signal?: AbortSignal) =>
  request<Lead>(leadPath(agentId, conversationId), { signal });

/** `null` убирает лид из воронки; отсутствие поля оставляет стадию как была. */
export const setLeadStage = (agentId: string, conversationId: string, stageId: string | null) =>
  request<Lead>(leadPath(agentId, conversationId), { method: 'PATCH', body: { stageId } });

export const assignLead = (agentId: string, conversationId: string, assignedTo: string | null) =>
  request<Lead>(leadPath(agentId, conversationId), { method: 'PATCH', body: { assignedTo } });

/** Пустая строка стирает ответ: незаполненное поле и поле с пустым ответом — одно и то же. */
export const setLeadField = (
  agentId: string,
  conversationId: string,
  fieldId: string,
  value: string,
) =>
  request<Lead>(`${leadPath(agentId, conversationId)}/fields/${fieldId}`, {
    method: 'PUT',
    body: { value },
  });

export const addNote = (agentId: string, conversationId: string, body: string) =>
  request<Lead>(`/agents/${agentId}/conversations/${conversationId}/notes`, {
    method: 'POST',
    body: { body },
  });

// ── Заказы ───────────────────────────────────────────────────────────────────

export const createOrder = (
  agentId: string,
  conversationId: string,
  body: { amount: string; status: 'pending' | 'paid'; comment: string },
) =>
  request<Lead>(`/agents/${agentId}/conversations/${conversationId}/orders`, {
    method: 'POST',
    body,
  });

export const updateOrder = (
  agentId: string,
  orderId: string,
  body: { amount?: string; status?: 'pending' | 'paid' | 'cancelled'; comment?: string },
) => request<Lead>(`/agents/${agentId}/orders/${orderId}`, { method: 'PATCH', body });

export const deleteOrder = (agentId: string, orderId: string) =>
  request<Lead>(`/agents/${agentId}/orders/${orderId}`, { method: 'DELETE' });

// ── Knowledge base ───────────────────────────────────────────────────────────

const knowledge = (agentId: string) => `/agents/${agentId}/knowledge`;

/**
 * With a query it is a search, without one a list. One route for both is deliberate: the
 * owner has to test exactly the search stage 5's agent uses.
 */
export const listKbItems = (
  agentId: string,
  params: { kind?: KbItemKind; q?: string },
  signal?: AbortSignal,
) => request<KbItem[]>(`${knowledge(agentId)}/items`, { query: params, signal });

export const createKbItem = (
  agentId: string,
  body: { kind: KbItemKind; title: string; content: string },
) => request<KbItem>(`${knowledge(agentId)}/items`, { method: 'POST', body });

export const updateKbItem = (
  agentId: string,
  itemId: string,
  body: { kind?: KbItemKind; title?: string; content?: string },
) => request<KbItem>(`${knowledge(agentId)}/items/${itemId}`, { method: 'PATCH', body });

export const deleteKbItem = (agentId: string, itemId: string) =>
  request<{ ok: true }>(`${knowledge(agentId)}/items/${itemId}`, { method: 'DELETE' });

export const listKbSources = (agentId: string, signal?: AbortSignal) =>
  request<KbSource[]>(`${knowledge(agentId)}/sources`, { signal });

/** Owner only on the server: an import writes a batch nobody has read yet. */
export const importKbText = (
  agentId: string,
  body: { title: string; kind: KbItemKind; text: string },
) => request<KbImport>(`${knowledge(agentId)}/import/text`, { method: 'POST', body });

/** Owner only. The fetch happens inside the request, so it can take seconds. */
export const importKbPage = (agentId: string, url: string) =>
  request<KbImport>(`${knowledge(agentId)}/import/page`, { method: 'POST', body: { url } });

/** Owner only, and only for a page source: it refetches and replaces what it made. */
export const reimportKbSource = (agentId: string, sourceId: string) =>
  request<KbImport>(`${knowledge(agentId)}/sources/${sourceId}/reimport`, { method: 'POST' });

/** Owner only. The items stay — only the record of where they came from goes. */
export const deleteKbSource = (agentId: string, sourceId: string) =>
  request<{ ok: true }>(`${knowledge(agentId)}/sources/${sourceId}`, { method: 'DELETE' });

// ── Агент (ИИ) ───────────────────────────────────────────────────────────────

export const getAiSettings = (agentId: string, signal?: AbortSignal) =>
  request<AiSettings>(`/agents/${agentId}/ai`, { signal });

/**
 * What may be changed about the agent. Owner only on the server.
 *
 * Every field is optional and an absent one is left as it stands, so a form can send what
 * it edited and nothing else. `openrouterKey` is the exception worth naming: `undefined`
 * keeps the stored key, an explicit `null` deletes it, and a string replaces it. The key
 * never comes back — `keySet` is all a reader is told.
 */
export const updateAiSettings = (
  agentId: string,
  body: {
    aiEnabled?: boolean;
    model?: string;
    temperature?: number;
    instructions?: string;
    replyLanguage?: string;
    openrouterKey?: string | null;
  },
) => request<AiSettings>(`/agents/${agentId}/ai`, { method: 'PATCH', body });

/** The same list for every account: model ids the server will accept, with their lines. */
export const listAiModels = (signal?: AbortSignal) =>
  request<AiModel[]>('/ai/models', { signal });

/**
 * Во что обошлись ответы агента за период, и во что — каждая модель отдельно.
 *
 * Любому сотруднику: настройки правит владелец, но потрачены деньги компании.
 * `total` приходит `null`, когда за период ходов не было, — это не то же самое, что
 * строка нулей, и экран говорит об этом словами.
 */
export const getAiUsage = (agentId: string, period: AiUsagePeriod, signal?: AbortSignal) =>
  request<AiUsage>(`/agents/${agentId}/ai/usage?period=${period}`, { signal });

/**
 * Один ход агента, который никуда не уходит.
 *
 * Сообщения клиенту не отправляется, лид не меняется, в переписке ничего не остаётся —
 * возвращается только то, что агент сделал бы. Ходов на весь сервер разрешено немного, и
 * сверх того запрос отвечает 429 с текстом про занятую песочницу.
 */
export const runAiSandbox = (agentId: string, text: string) =>
  request<AiTurn>(`/agents/${agentId}/ai/sandbox`, {
    method: 'POST',
    body: { text },
    // The model has sixty seconds on the server; the default client deadline is thirty.
    timeoutMs: LONG_TIMEOUT_MS,
  });

/** Any member: the operator watching the agent go wrong is the one who has to stop it. */
export const setConversationAi = (agentId: string, conversationId: string, aiEnabled: boolean) =>
  request<{ aiEnabled: boolean }>(`/agents/${agentId}/conversations/${conversationId}/ai`, {
    method: 'PATCH',
    body: { aiEnabled },
  });

// ── Meta Conversions API ─────────────────────────────────────────────────────

const capi = (agentId: string) => `/agents/${agentId}/capi`;

/**
 * Любому сотруднику: оператор, который видит неотправленный отчёт, должен понимать,
 * настроен ли набор данных вообще. Токена в ответе нет — только признак, что он есть.
 *
 * Агент, у которого ничего не настроено, отвечает пустой карточкой (`datasetId: ''`),
 * а не `null`: форме есть что показать в обоих случаях.
 */
export const getCapiSettings = (agentId: string, signal?: AbortSignal) =>
  request<CapiSettings>(capi(agentId), { signal });

/**
 * Сохранить набор данных и токен. Только владельцу.
 *
 * Сервер сначала проверяет пару в Meta и лишь потом пишет её: набор с опечаткой примут
 * молча все, кроме Meta. Поэтому 502 здесь — это отказ Meta, и его текст показывается
 * целиком.
 *
 * `accessToken` необязателен: без него проверяется и остаётся сохранённый токен, так что
 * переключатель и тестовый код правятся, не доставая токен из Meta заново.
 */
export const saveCapiSettings = (
  agentId: string,
  body: {
    datasetId: string;
    accessToken?: string;
    testEventCode?: string | null;
    enabled?: boolean;
  },
) => request<CapiSettings>(capi(agentId), { method: 'PUT', body });

/**
 * Убрать набор данных. Только владельцу.
 *
 * Уже поставленные в очередь события остаются: слив пометит их как неотправленные и
 * напишет почему — удалять их вместе с настройкой значило бы забрать и объяснение.
 */
export const deleteCapiSettings = (agentId: string) =>
  request<{ ok: true }>(capi(agentId), { method: 'DELETE' });

/** Журнал: последние пятьдесят событий агента, либо все события одного диалога. */
export const listCapiEvents = (
  agentId: string,
  params: { conversationId?: string } = {},
  signal?: AbortSignal,
) => request<CapiEvent[]>(`${capi(agentId)}/events`, { query: params, signal });

/**
 * Отправить событие ещё раз. Любому сотруднику — и это безопасно.
 *
 * `event_id` при повторе не меняется, а Meta считает одну конверсию на `event_id`:
 * сколько бы раз кнопку ни нажали, покупка засчитается один раз. Событие диалога,
 * пришедшего не из рекламы, сервер отправлять откажется — отправлять нечего.
 */
export const resendCapiEvent = (agentId: string, eventId: string) =>
  request<CapiEvent>(`${capi(agentId)}/events/${eventId}/resend`, { method: 'POST' });

// ── Статистика ───────────────────────────────────────────────────────────────

/**
 * Сколько лидов стоит сейчас на каждой стадии. Любому сотруднику.
 *
 * Периода здесь нет, и это не упущение: карточка считает все диалоги агента, включая
 * заведённые до того, как кабинет начал записывать переходы. Именно она отвечает на
 * «почему воронка пустая, у меня двести лидов».
 */
export const getStatsCurrent = (agentId: string, signal?: AbortSignal) =>
  request<StatsCurrent>(`/agents/${agentId}/stats/current`, { signal });
