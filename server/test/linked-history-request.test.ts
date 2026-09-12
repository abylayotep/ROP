import { describe, expect, it, vi } from 'vitest';
import { createHistoryRequestManager, type HistoryTarget } from '../src/lib/whatsapp/linked/history-request.js';
import { fakeLinked } from './helpers/fake-linked.js';

const targets = [
  { numberId: 'n1', jid: '7701@s.whatsapp.net', key: { id: 'm1', remoteJid: '7701@s.whatsapp.net', fromMe: false }, timestamp: 1_700_000_000_000 },
  { numberId: 'n1', jid: '7702@s.whatsapp.net', key: { id: 'm2', remoteJid: '7702@s.whatsapp.net', fromMe: true }, timestamp: 1_600_000_000_000 },
];

describe('linked on-demand history manager', () => {
  it('reports dispatch and timeout without exposing message keys or payloads', async () => {
    vi.useFakeTimers();
    const reports: unknown[] = [];
    const linked = fakeLinked({ requestHistory: async () => 'private-session-id' });
    const manager = createHistoryRequestManager(linked, {
      loadTargets: async () => targets.slice(0, 1), paceMs: 0, timeoutMs: 100,
      onDiagnostic: (report) => reports.push(report),
    });
    try {
      await manager.start('a1', 100);
      await vi.advanceTimersByTimeAsync(101);
      expect(reports).toEqual([
        { event: 'sent', requestedChats: 1, receivedChats: 0, receivedMessages: 0, failedChats: 0 },
        { event: 'finished', status: 'failed', requestedChats: 1, receivedChats: 0, receivedMessages: 0, failedChats: 1 },
      ]);
      expect(JSON.stringify(reports)).not.toContain('private-session-id');
    } finally {
      manager.close();
      vi.useRealTimers();
    }
  });
  it('counts only correlated raw history responses and completes after every chat responds', async () => {
    const linked = fakeLinked({ requestHistory: vi.fn(async (_numberId, _count, key) => `session-${key.id}`) });
    linked.setOpen('n1', true);
    const manager = createHistoryRequestManager(linked, { loadTargets: async () => targets, paceMs: 0, timeoutMs: 100 });

    const started = await manager.start('a1', 100);
    await vi.waitFor(() => expect(manager.get('a1')?.status).toBe('waiting'));
    linked.emit({ type: 'history', numberId: 'n1', chunk: { messages: [{ key: { id: 'x' } }], contacts: [], peerDataRequestSessionId: 'unrelated' } });
    expect(manager.get('a1')?.receivedChats).toBe(0);
    linked.emit({ type: 'history', numberId: 'n1', chunk: { messages: [{ key: { id: 'x' } }], contacts: [], peerDataRequestSessionId: 'session-m1' } });
    linked.emit({ type: 'history', numberId: 'n1', chunk: { messages: [{ key: { id: 'y' } }, { key: { id: 'z' } }], contacts: [], peerDataRequestSessionId: 'session-m2' } });

    expect(manager.get('a1')).toMatchObject({ id: started.id, status: 'completed', requestedChats: 2, receivedChats: 2, receivedMessages: 3, failedChats: 0 });
    manager.close();
  });

  it('returns the active run instead of starting a duplicate', async () => {
    const linked = fakeLinked({ requestHistory: async () => 'session-1' });
    linked.setOpen('n1', true);
    const manager = createHistoryRequestManager(linked, { loadTargets: async () => targets.slice(0, 1), paceMs: 0, timeoutMs: 100 });
    const first = await manager.start('a1', 100);
    const second = await manager.start('a1', 200);
    expect(second.id).toBe(first.id);
    expect(second.limit).toBe(100);
    manager.close();
  });

  it('reports failure after the response timeout when the phone returned nothing', async () => {
    vi.useFakeTimers();
    const linked = fakeLinked({ requestHistory: async (_numberId, _count, key) => `session-${key.id}` });
    linked.setOpen('n1', true);
    const manager = createHistoryRequestManager(linked, { loadTargets: async () => targets, paceMs: 0, timeoutMs: 90_000 });
    await manager.start('a1', 200);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(manager.get('a1')).toMatchObject({ status: 'failed', requestedChats: 2, receivedChats: 0, failedChats: 2 });
    manager.close();
    vi.useRealTimers();
  });

  it('reserves the agent before loading targets so concurrent starts share one run', async () => {
    let release!: (loaded: HistoryTarget[]) => void;
    const loading = new Promise<HistoryTarget[]>((resolve) => { release = resolve; });
    const linked = fakeLinked({ requestHistory: async () => 'session-1' });
    const manager = createHistoryRequestManager(linked, { loadTargets: async () => loading, paceMs: 0 });
    const first = manager.start('a1', 100);
    const second = await manager.start('a1', 200);
    release(targets);
    expect(second.id).toBe((await first).id);
    expect(second.limit).toBe(100);
    manager.close();
  });

  it('fails and stops dispatch when one history request never settles', async () => {
    vi.useFakeTimers();
    const requestHistory = vi.fn(async () => new Promise<string>(() => undefined));
    const linked = fakeLinked({ requestHistory });
    const manager = createHistoryRequestManager(linked, {
      loadTargets: async () => targets,
      paceMs: 0,
      sendTimeoutMs: 10_000,
      jobTimeoutMs: 300_000,
    });
    await manager.start('a1', 100);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(manager.get('a1')).toMatchObject({ status: 'failed', requestedChats: 1, receivedChats: 0, failedChats: 1 });
    expect(requestHistory).toHaveBeenCalledTimes(1);
    manager.close();
    vi.useRealTimers();
  });

  it('counts a correlated response emitted before requestHistory resolves', async () => {
    let resolveRequest!: (id: string) => void;
    const linked = fakeLinked({ requestHistory: async () => new Promise<string>((resolve) => { resolveRequest = resolve; }) });
    const manager = createHistoryRequestManager(linked, { loadTargets: async () => targets.slice(0, 1), paceMs: 0 });
    await manager.start('a1', 100);
    linked.emit({ type: 'history', numberId: 'n1', chunk: { messages: [{ key: { id: 'early' } }], contacts: [], peerDataRequestSessionId: 'early-session' } });
    resolveRequest('early-session');
    await vi.waitFor(() => expect(manager.get('a1')?.status).toBe('completed'));
    expect(manager.get('a1')).toMatchObject({ receivedChats: 1, receivedMessages: 1, failedChats: 0 });
    manager.close();
  });

  it('clears the failed load job deadline before a retry starts', async () => {
    vi.useFakeTimers();
    let loads = 0;
    const linked = fakeLinked({ requestHistory: async () => new Promise<string>(() => undefined) });
    const manager = createHistoryRequestManager(linked, {
      loadTargets: async () => (++loads === 1 ? Promise.reject(new Error('load failed')) : targets.slice(0, 1)),
      paceMs: 0,
      sendTimeoutMs: 1_000,
      jobTimeoutMs: 300,
    });
    await expect(manager.start('a1', 100)).rejects.toThrow('load failed');
    await vi.advanceTimersByTimeAsync(100);
    await manager.start('a1', 100);
    await vi.advanceTimersByTimeAsync(201);
    expect(manager.get('a1')?.status).toBe('requesting');
    manager.close();
    vi.useRealTimers();
  });

  it('does not let a late old load rejection delete a newer run', async () => {
    vi.useFakeTimers();
    let rejectOld!: (error: Error) => void;
    const oldLoad = new Promise<HistoryTarget[]>((_resolve, reject) => { rejectOld = reject; });
    let loads = 0;
    const linked = fakeLinked({ requestHistory: async () => new Promise<string>(() => undefined) });
    const manager = createHistoryRequestManager(linked, {
      loadTargets: async () => (++loads === 1 ? oldLoad : targets.slice(0, 1)),
      paceMs: 0,
      sendTimeoutMs: 1_000,
      jobTimeoutMs: 100,
    });
    const oldStart = manager.start('a1', 100);
    await vi.advanceTimersByTimeAsync(101);
    const newer = await manager.start('a1', 200);
    rejectOld(new Error('late old failure'));
    await expect(oldStart).rejects.toThrow('late old failure');
    expect(manager.get('a1')?.id).toBe(newer.id);
    manager.close();
    vi.useRealTimers();
  });
});
