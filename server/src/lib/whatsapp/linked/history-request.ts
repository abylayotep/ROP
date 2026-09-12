import { randomUUID } from 'node:crypto';
import type { WhatsappHistoryRun } from '@rakurs/contract';
import type { LinkedClient, RawLinkedMessage } from './client.js';

export interface HistoryTarget {
  numberId: string;
  jid: string;
  key: RawLinkedMessage['key'];
  timestamp: number;
}

export interface HistoryRequestManagerDeps {
  loadTargets(agentId: string, limit: 100 | 200): Promise<HistoryTarget[]>;
  timeoutMs?: number;
  paceMs?: number;
  sendTimeoutMs?: number;
  jobTimeoutMs?: number;
}

const active = (run: WhatsappHistoryRun): boolean =>
  run.status === 'requesting' || run.status === 'waiting';

export function createHistoryRequestManager(client: LinkedClient, deps: HistoryRequestManagerDeps) {
  const runs = new Map<string, WhatsappHistoryRun>();
  const sessions = new Map<string, { agentId: string; numberId: string; received: boolean }>();
  const earlyResponses = new Map<string, { messages: number; expiresAt: number }>();
  const timers = new Map<string, Set<NodeJS.Timeout>>();
  const timeoutMs = deps.timeoutMs ?? 90_000;
  const paceMs = deps.paceMs ?? 250;
  const sendTimeoutMs = deps.sendTimeoutMs ?? 10_000;
  const jobTimeoutMs = deps.jobTimeoutMs ?? 300_000;
  let closed = false;

  class SendTimeout extends Error {}

  const removeTimer = (agentId: string, timer: NodeJS.Timeout) => {
    const owned = timers.get(agentId);
    owned?.delete(timer);
    if (owned?.size === 0) timers.delete(agentId);
  };

  const schedule = (agentId: string, delay: number, callback: () => void) => {
    const timer = setTimeout(() => {
      removeTimer(agentId, timer);
      callback();
    }, delay);
    timer.unref?.();
    const owned = timers.get(agentId) ?? new Set<NodeJS.Timeout>();
    owned.add(timer);
    timers.set(agentId, owned);
    return timer;
  };

  const clearAgentTimers = (agentId: string) => {
    for (const timer of timers.get(agentId) ?? []) clearTimeout(timer);
    timers.delete(agentId);
  };

  const responseKey = (numberId: string, sessionId: string) => `${numberId}\u0000${sessionId}`;

  const pruneEarlyResponses = () => {
    const now = Date.now();
    for (const [key, response] of earlyResponses) {
      if (response.expiresAt <= now) earlyResponses.delete(key);
    }
    while (earlyResponses.size >= 500) earlyResponses.delete(earlyResponses.keys().next().value!);
  };

  const finish = (agentId: string, run: WhatsappHistoryRun, status: WhatsappHistoryRun['status'], error: string | null = null) => {
    if (runs.get(agentId) !== run || !active(run)) return;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.error = error;
    run.failedChats = run.requestedChats - run.receivedChats;
    clearAgentTimers(agentId);
    for (const [sessionId, pending] of sessions) {
      if (pending.agentId === agentId) sessions.delete(sessionId);
    }
  };

  const receive = (agentId: string, pending: { received: boolean }, messageCount: number) => {
    if (pending.received) return;
    const run = runs.get(agentId);
    if (!run || !active(run)) return;
    pending.received = true;
    run.receivedChats += 1;
    run.receivedMessages += messageCount;
    if (run.status === 'waiting' && run.receivedChats + run.failedChats === run.requestedChats) {
      finish(agentId, run, run.failedChats === 0 ? 'completed' : 'partial');
    }
  };

  const unsubscribe = client.on((event) => {
    if (event.type !== 'history' || !event.chunk.peerDataRequestSessionId) return;
    const key = responseKey(event.numberId, event.chunk.peerDataRequestSessionId);
    const pending = sessions.get(key);
    if (pending) {
      receive(pending.agentId, pending, event.chunk.messages?.length ?? 0);
      return;
    }
    if (![...runs.values()].some((run) => run.status === 'requesting')) return;
    pruneEarlyResponses();
    earlyResponses.set(key, {
      messages: event.chunk.messages?.length ?? 0,
      expiresAt: Date.now() + 15_000,
    });
  });

  const requestWithDeadline = async (agentId: string, operation: Promise<string>) =>
    new Promise<string>((resolve, reject) => {
      const timer = schedule(agentId, sendTimeoutMs, () => reject(new SendTimeout()));
      operation.then(
        (value) => { clearTimeout(timer); removeTimer(agentId, timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); removeTimer(agentId, timer); reject(error); },
      );
    });

  const pace = (agentId: string) => new Promise<void>((resolve) => {
    if (paceMs <= 0) return resolve();
    schedule(agentId, paceMs, resolve);
  });

  const startRequests = async (agentId: string, run: WhatsappHistoryRun, targets: HistoryTarget[]) => {
    for (const target of targets) {
      if (closed || !active(run)) return;
      run.requestedChats += 1;
      try {
        if (!client.requestHistory) throw new Error('On-demand history is unavailable');
        const sessionId = await requestWithDeadline(
          agentId,
          client.requestHistory(target.numberId, 50, target.key, target.timestamp),
        );
        if (closed || !active(run)) return;
        const pending = { agentId, numberId: target.numberId, received: false };
        sessions.set(responseKey(target.numberId, sessionId), pending);
        pruneEarlyResponses();
        const early = earlyResponses.get(responseKey(target.numberId, sessionId));
        if (early) {
          earlyResponses.delete(responseKey(target.numberId, sessionId));
          receive(agentId, pending, early.messages);
        }
      } catch (error) {
        run.failedChats += 1;
        if (error instanceof SendTimeout) {
          finish(agentId, run, run.receivedChats > 0 ? 'partial' : 'failed', 'WhatsApp не ответил на запрос истории вовремя.');
          return;
        }
      }
      await pace(agentId);
    }
    if (!active(run)) return;
    if (run.requestedChats === 0 || run.failedChats === run.requestedChats) {
      finish(agentId, run, 'failed', 'WhatsApp не принял ни одного запроса истории.');
      return;
    }
    run.status = 'waiting';
    if (run.receivedChats + run.failedChats === run.requestedChats) {
      finish(agentId, run, run.failedChats === 0 ? 'completed' : 'partial');
      return;
    }
    schedule(agentId, timeoutMs, () => finish(
      agentId,
      run,
      run.receivedChats > 0 ? 'partial' : 'failed',
      'WhatsApp не прислал историю за отведённое время.',
    ));
  };

  return {
    get: (agentId: string): WhatsappHistoryRun | null => runs.get(agentId) ?? null,
    async start(agentId: string, limit: 100 | 200): Promise<WhatsappHistoryRun> {
      if (closed) throw new Error('Менеджер истории остановлен.');
      const existing = runs.get(agentId);
      if (existing && active(existing)) return existing;
      const now = new Date().toISOString();
      const run: WhatsappHistoryRun = {
        id: randomUUID(), status: 'requesting', limit, totalChats: 0,
        requestedChats: 0, receivedChats: 0, receivedMessages: 0, failedChats: 0,
        startedAt: now, finishedAt: null, error: null,
      };
      if (runs.size >= 500) {
        const oldestFinished = [...runs].find(([, candidate]) => !active(candidate));
        if (!oldestFinished) throw new Error('Слишком много одновременных запросов истории.');
        runs.delete(oldestFinished[0]);
      }
      runs.set(agentId, run);
      schedule(agentId, jobTimeoutMs, () => finish(
        agentId,
        run,
        run.receivedChats > 0 ? 'partial' : 'failed',
        'Запрос истории превысил общий лимит времени.',
      ));
      let targets: HistoryTarget[];
      try {
        targets = await deps.loadTargets(agentId, limit);
      } catch (error) {
        if (runs.get(agentId) === run) {
          clearAgentTimers(agentId);
          runs.delete(agentId);
        }
        throw error;
      }
      run.totalChats = targets.length;
      void startRequests(agentId, run, targets).catch((error: unknown) =>
        finish(agentId, run, 'failed', 'Не удалось запросить историю WhatsApp.'),
      );
      return run;
    },
    close() {
      closed = true;
      unsubscribe();
      for (const owned of timers.values()) for (const timer of owned) clearTimeout(timer);
      timers.clear();
      sessions.clear();
      earlyResponses.clear();
      runs.clear();
    },
  };
}
