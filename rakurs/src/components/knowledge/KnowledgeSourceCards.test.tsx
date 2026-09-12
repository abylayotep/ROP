import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhatsappHistoryOverview } from '@rakurs/contract';
import type { WhatsappHistoryArchivePacket } from '@/api';

const fixture = vi.hoisted(() => ({
  overview: undefined as WhatsappHistoryOverview | undefined,
  archive: [] as WhatsappHistoryArchivePacket[],
  pollingCall: 0,
  refreshError: undefined as unknown,
  instagramSetup: vi.fn(),
}));

vi.mock('@/hooks/usePollingApi', () => ({
  usePollingApi: () => ({
    data: fixture.pollingCall++ % 2 === 0 ? fixture.overview : fixture.archive,
    error: fixture.refreshError,
    loading: false,
    refreshing: false,
    reload: vi.fn(),
  }),
}));
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ data: [], error: undefined, loading: false, reload: vi.fn() }),
}));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ fail: vi.fn(), ok: vi.fn() }),
}));
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();
  return { ...actual, getInstagramSetup: fixture.instagramSetup };
});

import { KnowledgeSourceCards } from './KnowledgeSourceCards';

const text = (node: { children?: unknown[] }): string =>
  (node.children ?? []).map((child) => typeof child === 'string' ? child : text(child as { children?: unknown[] })).join('');

function render(onOpenRecentHistory = vi.fn()) {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <KnowledgeSourceCards agentId="agent-1" onChanged={() => undefined} onOpenRecentHistory={onOpenRecentHistory} />
      </MemoryRouter>,
    );
  });
  return renderer!;
}

describe('KnowledgeSourceCards', () => {
  beforeEach(() => {
    fixture.overview = { connectedNumbers: 1, availableChats: 42, run: null };
    fixture.archive = [{
      id: 'packet-1', numberId: 'number-1', status: 'done', attempts: 1, errorCode: null,
      counts: { received: 25, saved: 20, duplicates: 5, excluded: 0, skippedUnresolved: 0 },
      createdAt: '2026-09-12T00:00:00Z', expiresAt: '2026-09-19T00:00:00Z', canReplay: true,
    }];
    fixture.pollingCall = 0;
    fixture.refreshError = undefined;
    fixture.instagramSetup.mockReset();
  });

  it('keeps exactly one source expanded and mounts only its existing import panel', () => {
    const renderer = render();
    const headers = () => renderer.root.findAllByType('button').filter((button) => button.props['aria-expanded'] !== undefined);

    expect(headers()).toHaveLength(4);
    expect(headers().filter((button) => button.props['aria-expanded'] === true)).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Вставить текст' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Загрузка истории WhatsApp' })).toHaveLength(0);

    act(() => headers().find((button) => button.props['aria-label'] === 'WhatsApp')!.props.onClick());

    expect(headers().filter((button) => button.props['aria-expanded'] === true)).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Загрузка истории WhatsApp' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Вставить текст' })).toHaveLength(0);
  });

  it('shows real WhatsApp connection and archive state while the card is collapsed', () => {
    const renderer = render();
    const whatsapp = renderer.root.findByProps({ 'data-source-card': 'whatsapp' });
    expect(text(whatsapp)).toContain('Подключений: 1');
    expect(text(whatsapp)).toContain('42 чата');
    expect(text(whatsapp)).toContain('Обработано');
  });

  it('does not present stale WhatsApp status as freshly checked after polling fails', () => {
    fixture.refreshError = new Error('Status refresh failed');
    const whatsapp = render().root.findByProps({ 'data-source-card': 'whatsapp' });
    expect(text(whatsapp)).toContain('данные не обновились');
  });

  it('keeps the two-week preparation shortcut in the expanded WhatsApp card', () => {
    const onOpenRecentHistory = vi.fn();
    const renderer = render(onOpenRecentHistory);
    const whatsapp = renderer.root.findByProps({ 'aria-label': 'WhatsApp' });
    act(() => whatsapp.props.onClick());
    const shortcut = renderer.root.findAllByType('button').find((button) => text(button).includes('последние 2 недели'))!;
    expect(shortcut).toBeDefined();
    act(() => shortcut.props.onClick());
    expect(onOpenRecentHistory).toHaveBeenCalledOnce();
  });

  it('reuses the import panel for text, web page, and the existing Instagram setup flow', async () => {
    fixture.instagramSetup.mockRejectedValueOnce(new Error('OAuth window was blocked'));
    const renderer = render();
    const header = (label: string) => renderer.root.findByProps({ 'aria-label': label });

    expect(renderer.root.findAllByProps({ 'aria-label': 'Вставить текст' })).toHaveLength(1);
    act(() => header('Веб-страница').props.onClick());
    expect(renderer.root.findAllByProps({ 'aria-label': 'Загрузить веб-страницу' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Вставить текст' })).toHaveLength(0);

    act(() => header('Instagram').props.onClick());
    const connect = renderer.root.findAllByType('button').find((button) => text(button) === 'Подключить Instagram')!;
    await act(async () => { connect.props.onClick(); });

    expect(fixture.instagramSetup).toHaveBeenCalledWith('agent-1', expect.any(AbortSignal));
    const alert = renderer.root.findByProps({ role: 'alert' });
    expect(text(alert)).toContain('OAuth window was blocked');
    expect(text(alert).toLowerCase()).toContain('попробуйте снова');
    expect(alert.findAllByType('a').some((link) => link.props.href === 'https://developers.facebook.com/apps/')).toBe(true);
  });

  it('moves the expanded card with arrow keys without leaving two panels open', () => {
    const renderer = render();
    const textHeader = renderer.root.findByProps({ 'aria-label': 'Текст' });
    act(() => textHeader.props.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() }));

    const headers = renderer.root.findAllByType('button').filter((button) => button.props['aria-expanded'] !== undefined);
    expect(headers.filter((button) => button.props['aria-expanded'] === true)).toHaveLength(1);
    expect(renderer.root.findByProps({ 'aria-label': 'Веб-страница' }).props['aria-expanded']).toBe(true);
  });
});
