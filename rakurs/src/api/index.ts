import type {
  Agent,
  AgentRule,
  AiModel,
  AiSettings,
  AiTestContact,
  AiTurn,
  AiUsage,
  AiUsagePeriod,
  Board,
  CapiEvent,
  CapiSettings,
  CommunicationStyle,
  CommunicationStyleSettings,
  CoachMessage,
  CoachProposal,
  CoexistenceConnection,
  ConversationSummary,
  ConversationThread,
  Customer,
  EmbeddedSignupSetup,
  InstagramSetup,
  KbGraph,
  KbImport,
  KbGenerationDraftRequest,
  KbGenerationDraftResponse,
  KbGenerationPreview,
  KbGenerationPreviewRequest,
  KbGenerationProposal,
  KbGenerationProposalUpdateRequest,
  KbGenerationRun,
  KbGenerationRunDetail,
  KbGenerationRunPage,
  KbGenerationStartRequest,
  KbNote,
  KbNoteDetail,
  KbDraft,
  KbDraftDetail,
  KbNoteKind,
  KbSection,
  KbSource,
  Lead,
  LeadField,
  Me,
  Member,
  Message,
  Period,
  RuleCategory,
  Stage,
  StatsCurrent,
  StatsPeriodReport,
  SuggestedCase,
  TestCase,
  TestRun,
  WebhookSetup,
  WhatsappNumber,
} from '@/types';
import { API_URL, LONG_TIMEOUT_MS, request } from './client';
import type { WhatsappHistoryRun, WhatsappHistoryOverview } from '@rakurs/contract';

export type WhatsappHistoryArchivePacket = {
  id: string;
  numberId: string;
  status: string;
  counts: { received: number; saved: number; duplicates: number; excluded: number; skippedUnresolved: number };
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string;
  canReplay: boolean;
};

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

export const getCommunicationStyle = (agentId: string, signal?: AbortSignal) =>
  request<CommunicationStyleSettings>(`/agents/${agentId}/communication-style`, { signal });

export const updateCommunicationStyle = (agentId: string, preset: CommunicationStyle) =>
  request<CommunicationStyleSettings>(`/agents/${agentId}/communication-style`, {
    method: 'PATCH',
    body: { preset },
  });

// ── WhatsApp ─────────────────────────────────────────────────────────────────

export const getWhatsappHistory = (agentId: string, signal?: AbortSignal) =>
  request<WhatsappHistoryOverview>(`/agents/${agentId}/whatsapp/history`, { signal });

export const startWhatsappHistory = (agentId: string, limit: 100 | 200, signal?: AbortSignal) =>
  request<WhatsappHistoryRun>(`/agents/${agentId}/whatsapp/history`, {
    method: 'POST', body: { limit }, signal,
  });

export const getWhatsappHistoryArchive = (agentId: string, signal?: AbortSignal) =>
  request<WhatsappHistoryArchivePacket[]>(`/agents/${agentId}/whatsapp/history/archive`, { signal });

export const replayWhatsappHistoryArchive = (agentId: string, packetId: string) =>
  request<WhatsappHistoryArchivePacket>(`/agents/${agentId}/whatsapp/history/archive/${packetId}/replay`, {
    method: 'POST', body: {},
  });

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

export const getEmbeddedSignupSetup = (agentId: string, signal?: AbortSignal) =>
  request<EmbeddedSignupSetup>(`/agents/${agentId}/whatsapp/embedded-signup`, { signal });

export const startLinkedPairing = (agentId: string) =>
  request<WhatsappNumber>(`/agents/${agentId}/whatsapp/linked`, { method: 'POST', body: {} });

export const reconnectLinkedPhone = (agentId: string, numberId: string) =>
  request<WhatsappNumber>(`/agents/${agentId}/whatsapp/linked/${numberId}/reconnect`, { method: 'POST', body: {} });

export const unlinkPhone = (agentId: string, numberId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/whatsapp/linked/${numberId}`, { method: 'DELETE' });

/** The URL the browser opens an EventSource on while a QR code is on screen. */
export const linkedPairingStream = (agentId: string, numberId: string) =>
  `${API_URL}/agents/${agentId}/whatsapp/linked/${numberId}/qr`;

export const connectCoexistenceNumber = (agentId: string, body: CoexistenceConnection) =>
  request<WhatsappNumber>(`/agents/${agentId}/whatsapp/coexistence`, { method: 'POST', body });

// ── Диалоги ──────────────────────────────────────────────────────────────────

export const listConversations = (
  agentId: string, signal?: AbortSignal, page?: { limit: number; offset: number; q?: string },
) => request<ConversationSummary[]>(`/agents/${agentId}/conversations`, { signal, query: page });

export const getConversation = (
  agentId: string, conversationId: string, signal?: AbortSignal,
  page?: { limit: number; before?: string; after?: string; around?: string },
) => {
  const query = new URLSearchParams();
  if (page) {
    query.set('limit', String(page.limit));
    for (const key of ['before', 'after', 'around'] as const) {
      if (page[key]) query.set(key, page[key]);
    }
  }
  return request<ConversationThread>(`/agents/${agentId}/conversations/${conversationId}${page ? `?${query}` : ''}`, { signal });
};

export const sendMessage = (agentId: string, conversationId: string, body: string) =>
  request<Message>(`/agents/${agentId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { body },
  });

/**
 * A file the operator is sending, with an optional caption.
 *
 * Its own route because its own request shape: a stream to disk, not a JSON string. The
 * timeout is the long one — a photo over a phone tether is not a database query.
 */
export const sendFile = (
  agentId: string,
  conversationId: string,
  file: File,
  caption: string,
) => {
  const form = new FormData();
  if (caption.trim()) form.append('caption', caption.trim());
  form.append('file', file);
  return request<Message>(`/agents/${agentId}/conversations/${conversationId}/files`, {
    method: 'POST',
    form,
    timeoutMs: LONG_TIMEOUT_MS,
  });
};

/** The address of a file inside a message. Access is checked by the session cookie. */
export const mediaUrl = (agentId: string, messageId: string) =>
  `${API_URL}/agents/${agentId}/messages/${messageId}/media`;

// ── Генерация базы знаний из диалогов ──────────────────────────────────────

const generationPath = (agentId: string) => `/agents/${agentId}/knowledge/generation`;

export const previewKnowledgeGeneration = (
  agentId: string,
  body: KbGenerationPreviewRequest,
  signal?: AbortSignal,
) => request<KbGenerationPreview>(`${generationPath(agentId)}/preview`, { method: 'POST', body, signal });

export const startKnowledgeGeneration = (agentId: string, body: KbGenerationStartRequest, signal?: AbortSignal) =>
  request<KbGenerationRun>(`${generationPath(agentId)}/runs`, { method: 'POST', body, signal });

export const listKnowledgeGenerationRuns = (agentId: string, cursor?: string, signal?: AbortSignal) =>
  request<KbGenerationRunPage>(`${generationPath(agentId)}/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });

export interface KnowledgeGenerationRunPageOptions {
  proposalCursor?: string;
  draftCursor?: string;
  exclusionCursor?: string;
  rawFindingCursor?: string;
  includeRawFindings?: boolean;
}

export const getKnowledgeGenerationRun = (
  agentId: string,
  runId: string,
  signal?: AbortSignal,
  page?: string | KnowledgeGenerationRunPageOptions,
  includeRawFindings = false,
) => {
  const query = new URLSearchParams();
  if (typeof page === 'string') query.set('proposalCursor', page);
  else if (page) {
    if (page.proposalCursor) query.set('proposalCursor', page.proposalCursor);
    if (page.draftCursor) query.set('draftCursor', page.draftCursor);
    if (page.exclusionCursor) query.set('exclusionCursor', page.exclusionCursor);
    if (page.rawFindingCursor) query.set('rawFindingCursor', page.rawFindingCursor);
  }
  if (includeRawFindings || (typeof page === 'object' && page.includeRawFindings)) query.set('includeRawFindings', 'true');
  const suffix = query.size > 0 ? `?${query}` : '';
  return request<KbGenerationRunDetail>(`${generationPath(agentId)}/runs/${runId}${suffix}`, { signal });
};

export const cancelKnowledgeGenerationRun = (agentId: string, runId: string) =>
  request<KbGenerationRun>(`${generationPath(agentId)}/runs/${runId}/cancel`, { method: 'POST' });

export const retryKnowledgeGenerationRun = (agentId: string, runId: string) =>
  request<KbGenerationRun>(`${generationPath(agentId)}/runs/${runId}/retry`, { method: 'POST' });

export const updateKnowledgeGenerationProposal = (
  agentId: string,
  proposalId: string,
  body: KbGenerationProposalUpdateRequest,
) => request<KbGenerationProposal>(`${generationPath(agentId)}/proposals/${proposalId}`, { method: 'PATCH', body });

export const createKnowledgeGenerationDraft = (
  agentId: string,
  runId: string,
  body: KbGenerationDraftRequest,
) => request<KbGenerationDraftResponse>(`${generationPath(agentId)}/runs/${runId}/draft`, { method: 'POST', body });

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
 * owner has to test exactly the search stage 5's agent uses, and the tree pane's own search
 * box calls this rather than filtering a cached list — the distinct notes of the ranker's
 * hits, in the ranker's own order, is not something the browser can reproduce from a plain
 * list of notes.
 */
export const listKbNotes = (
  agentId: string,
  params: { q?: string; kind?: KbNoteKind } = {},
  signal?: AbortSignal,
) => request<KbNote[]>(`${knowledge(agentId)}/notes`, { query: params, signal });

export const getKbNote = (agentId: string, noteId: string, signal?: AbortSignal) =>
  request<KbNoteDetail>(`${knowledge(agentId)}/notes/${noteId}`, { signal });

export const createKbNote = (agentId: string, body: { path: string; body: string }) =>
  request<KbNoteDetail>(`${knowledge(agentId)}/notes`, { method: 'POST', body });

export const updateKbNote = (
  agentId: string,
  noteId: string,
  body: { path?: string; body?: string },
) => request<KbNoteDetail>(`${knowledge(agentId)}/notes/${noteId}`, { method: 'PATCH', body });

export const deleteKbNote = (agentId: string, noteId: string) =>
  request<{ ok: true }>(`${knowledge(agentId)}/notes/${noteId}`, { method: 'DELETE' });

/** The same ranker `listKbNotes` calls with a query, but sections rather than whole notes —
 * what «Что найдёт агент» shows, because a note title is not what the agent quotes. */
export const searchKb = (agentId: string, q: string, signal?: AbortSignal) =>
  request<KbSection[]>(`${knowledge(agentId)}/search`, { query: { q }, signal });

/** The graph tab's own fetch: every note as a node, every resolved `[[link]]` as an edge. */
export const getKbGraph = (agentId: string, signal?: AbortSignal) =>
  request<KbGraph>(`${knowledge(agentId)}/graph`, { signal });

export const listKbSources = (agentId: string, signal?: AbortSignal) =>
  request<KbSource[]>(`${knowledge(agentId)}/sources`, { signal });

/** Owner only on the server: an import writes a batch nobody has read yet. */
export const importKbText = (
  agentId: string,
  body: { title: string; kind: KbNoteKind; text: string },
) => request<KbImport>(`${knowledge(agentId)}/import/text`, { method: 'POST', body });

/** Owner only. The fetch happens inside the request, so it can take seconds. */
export const importKbPage = (agentId: string, url: string) =>
  request<KbImport>(`${knowledge(agentId)}/import/page`, { method: 'POST', body: { url } });

export const getInstagramSetup = (agentId: string, signal?: AbortSignal) =>
  request<InstagramSetup>(`${knowledge(agentId)}/instagram`, { signal });

/**
 * Owner only, and slow on purpose: the server spends the code, reads the account and writes
 * every note before it answers, so the screen shows a finished import rather than a promise.
 */
export const importKbInstagram = (agentId: string, code: string) =>
  request<KbImport>(`${knowledge(agentId)}/import/instagram`, { method: 'POST', body: { code } });

/** Owner only, and only for a page source: it refetches and replaces what it made. */
export const reimportKbSource = (agentId: string, sourceId: string) =>
  request<KbImport>(`${knowledge(agentId)}/sources/${sourceId}/reimport`, { method: 'POST' });

/** Owner only. The items stay — only the record of where they came from goes. */
export const deleteKbSource = (agentId: string, sourceId: string) =>
  request<{ ok: true }>(`${knowledge(agentId)}/sources/${sourceId}`, { method: 'DELETE' });

// ── Агент (ИИ) ───────────────────────────────────────────────────────────────

export const getAiSettings = (agentId: string, signal?: AbortSignal) =>
  request<AiSettings>(`/agents/${agentId}/ai`, { signal });

/** Owner-only list of contacts eligible for the single test-mode slot. */
export const listAiTestContacts = (agentId: string, signal?: AbortSignal) =>
  request<AiTestContact[]>(`/agents/${agentId}/ai/test-contacts`, { signal });

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
    responseMode?: AiSettings['responseMode'];
    testContactId?: string | null;
    model?: string;
    temperature?: number;
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
 *
 * Дня, с которого идёт запись переходов, в этом ответе нет: карточка его не печатает, а
 * та, что печатает, получает его своим запросом.
 */
export const getStatsCurrent = (agentId: string, signal?: AbortSignal) =>
  request<StatsCurrent>(`/agents/${agentId}/stats/current`, { signal });

/**
 * Воронка, источники и деньги за период. Любому сотруднику.
 *
 * Период — тот же, что у расхода на ИИ: сутки, неделя или месяц, скользящим окном.
 * Сервер отвечает своим `since` — экран показывает именно тот момент, от которого
 * посчитаны цифры, а не свой собственный.
 *
 * Здесь три карточки с разной честностью, и `stageHistorySince` в ответе — про это:
 * источники и деньги считаются с того дня, как подключили номер, а движение по
 * воронке — только с того дня, когда кабинет начал его записывать.
 */
export const getStatsPeriod = (agentId: string, period: Period, signal?: AbortSignal) =>
  request<StatsPeriodReport>(`/agents/${agentId}/stats/period`, {
    query: { period },
    signal,
  });

// ── Правила агента ───────────────────────────────────────────────────────────

/**
 * In the order the model reads them — categories in the prompt's own sequence, then
 * position inside each. Owner only on the server; every route below is.
 */
export const listRules = (agentId: string, signal?: AbortSignal) =>
  request<AgentRule[]>(`/agents/${agentId}/rules`, { signal });

/** A new rule joins the end of its category. */
export const createRule = (agentId: string, body: { category: RuleCategory; text: string }) =>
  request<AgentRule>(`/agents/${agentId}/rules`, { method: 'POST', body });

export const updateRule = (
  agentId: string,
  ruleId: string,
  body: { category?: RuleCategory; text?: string; enabled?: boolean; position?: number },
) => request<AgentRule>(`/agents/${agentId}/rules/${ruleId}`, { method: 'PATCH', body });

export const deleteRule = (agentId: string, ruleId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/rules/${ruleId}`, { method: 'DELETE' });

// ── Коуч ──────────────────────────────────────────────────────────────────────

export const listCoachMessages = (agentId: string, signal?: AbortSignal) =>
  request<CoachMessage[]>(`/agents/${agentId}/coach/messages`, { signal });

/**
 * What a coaching turn answers: the model's own line, a possible proposal, and a warning
 * when the fact check turned a priced rule into a note.
 *
 * Not `CoachMessage` — the owner's line this same call writes is not handed back (the
 * screen already knows what it sent), and the model's row keeps its text under `message`,
 * not `text`, exactly as `server/src/api/coach.ts`'s `POST` route answers it.
 */
export interface CoachReply {
  id: string;
  message: string;
  proposal: CoachProposal | null;
  warning: string | null;
}

/**
 * One turn of the coaching chat. Costs money — an OpenRouter call runs on the other end —
 * and can hold a turn slot as long as a sandbox call, hence the same long deadline.
 */
export const sendCoachMessage = (
  agentId: string,
  body: { text: string; conversationId?: string; aiReplyId?: string },
) =>
  request<CoachReply>(`/agents/${agentId}/coach/messages`, {
    method: 'POST',
    body,
    timeoutMs: LONG_TIMEOUT_MS,
  });

/** The one answer that costs nothing: turning down a proposal writes no rule and no note. */
export const rejectCoachMessage = (agentId: string, messageId: string) =>
  request<CoachMessage>(`/agents/${agentId}/coach/messages/${messageId}/reject`, { method: 'POST' });

/** Where a coaching proposal becomes a draft — the route `ProposalCard`'s own comment names
 * as the one thing standing between «В черновик» and a live button. */
export const draftCoachMessage = (agentId: string, messageId: string) =>
  request<KbDraft>(`/agents/${agentId}/coach/messages/${messageId}/draft`, { method: 'POST' });

// ── Черновики и прогоны ──────────────────────────────────────────────────────

/** Every open draft of this agent, newest first — the way back in for an owner who left
 * `DraftScreen` before deciding. Shown in «Обучение», beside the coaching chat that made most
 * drafts in the first place. */
export const listOpenDrafts = (agentId: string, signal?: AbortSignal) =>
  request<KbDraft[]>(`/agents/${agentId}/drafts`, { signal });

export const getDraft = (agentId: string, draftId: string, signal?: AbortSignal) =>
  request<KbDraftDetail>(`/agents/${agentId}/drafts/${draftId}`, { signal });

/**
 * Starts a run and returns the instant it is admitted — `status: 'running'`, before a single
 * case has been replayed. `GET .../runs/:runId` below is how the rest is read: poll it and
 * watch `results` gain a row per case, exactly as `server/src/api/drafts.ts`'s own file
 * comment describes.
 */
export const runDraft = (agentId: string, draftId: string, caseIds: string[]) =>
  request<TestRun>(`/agents/${agentId}/drafts/${draftId}/runs`, { method: 'POST', body: { caseIds } });

export const getDraftRun = (agentId: string, draftId: string, runId: string, signal?: AbortSignal) =>
  request<TestRun>(`/agents/${agentId}/drafts/${draftId}/runs/${runId}`, { signal });

/** Refused for one of four reasons — see `api/drafts.ts`'s own file comment on the apply
 * route — and the refusal is a Russian sentence in `ApiError.body.message`, exactly what
 * `humanError` already surfaces: no client-side prediction of which of the four applies. */
export const applyDraft = (agentId: string, draftId: string) =>
  request<KbDraft>(`/agents/${agentId}/drafts/${draftId}/apply`, { method: 'POST' });

/** No op is ever applied for real before this, so there is nothing to undo — only the
 * draft's own status changes. */
export const discardDraft = (agentId: string, draftId: string) =>
  request<KbDraft>(`/agents/${agentId}/drafts/${draftId}/discard`, { method: 'POST' });

// ── Проверки ──────────────────────────────────────────────────────────────────

export const listTestCases = (agentId: string, signal?: AbortSignal) =>
  request<TestCase[]>(`/agents/${agentId}/test-cases`, { signal });

export const createTestCase = (
  agentId: string,
  body: { title: string; messages: string[]; expectation?: string | null },
) => request<TestCase>(`/agents/${agentId}/test-cases`, { method: 'POST', body });

export const updateTestCase = (
  agentId: string,
  caseId: string,
  body: { title?: string; messages?: string[]; expectation?: string | null; enabled?: boolean },
) => request<TestCase>(`/agents/${agentId}/test-cases/${caseId}`, { method: 'PATCH', body });

export const deleteTestCase = (agentId: string, caseId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/test-cases/${caseId}`, { method: 'DELETE' });

/** Copies a real dialog's customer side into a new, saved case — see `test-cases.ts`'s own
 * comment on why only the inbound messages are kept. */
export const createCaseFromDialog = (agentId: string, conversationId: string) =>
  request<TestCase>(`/agents/${agentId}/test-cases/from-dialog`, { method: 'POST', body: { conversationId } });

/** Suggestions only — nothing here is saved. A screen offers them as unticked rows the owner
 * may post back through `createTestCase`, one at a time or not at all. Given the same long
 * deadline as the coach and the sandbox: a real model call runs on the other end. */
export const suggestCases = (agentId: string, draftId: string) =>
  request<{ cases: SuggestedCase[] }>(`/agents/${agentId}/drafts/${draftId}/suggest-cases`, {
    method: 'POST',
    timeoutMs: LONG_TIMEOUT_MS,
  });
