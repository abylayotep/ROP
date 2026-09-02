import type { Agent, Me } from '@/types';
import { request } from './client';

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
