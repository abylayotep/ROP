import type {
  Agent,
  Board,
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
  WebhookSetup,
  WhatsappNumber,
} from '@/types';
import { API_URL, request } from './client';

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
