import type {
  Agent,
  ConversationSummary,
  ConversationThread,
  Me,
  Message,
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
