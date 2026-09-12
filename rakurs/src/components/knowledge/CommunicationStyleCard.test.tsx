import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunicationStyleSettings } from '@/types';

const fixture = vi.hoisted(() => ({
  data: { preset: 'warm', preview: 'Здравствуйте! С радостью помогу.' } as CommunicationStyleSettings | undefined,
  error: undefined as unknown,
  reload: vi.fn(),
}));
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ ...fixture, loading: false }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ fail: vi.fn(), ok: vi.fn() }) }));
import { CommunicationStyleCard, saveCommunicationStyle } from './CommunicationStyleCard';

beforeEach(() => {
  fixture.data = { preset: 'warm', preview: 'Здравствуйте! С радостью помогу.' };
  fixture.error = undefined;
  fixture.reload.mockReset();
});

describe('CommunicationStyleCard', () => {
  it('shows all presets and the preview returned by the style endpoint', () => {
    const html = renderToStaticMarkup(createElement(CommunicationStyleCard, { agentId: 'agent-1' }));
    expect(html).toContain('Стиль общения');
    expect(html).toContain('Живой и тёплый');
    expect(html).toContain('Спокойный');
    expect(html).toContain('Дружеский');
    expect(html).toContain('Здравствуйте! С радостью помогу.');
    expect(html).toContain('Сохранить стиль');
  });

  it('uses the saved endpoint response as preview source of truth', async () => {
    const saved = { preset: 'friendly', preview: 'Привет! Давайте разберёмся.' } as const;
    const update = vi.fn().mockResolvedValue(saved);
    await expect(saveCommunicationStyle('agent-1', 'friendly', update)).resolves.toEqual(saved);
    expect(update).toHaveBeenCalledWith('agent-1', 'friendly');
  });

  it('keeps style settings readable but immutable for members', () => {
    const html = renderToStaticMarkup(createElement(CommunicationStyleCard, { agentId: 'agent-1', readOnly: true }));
    expect(html).toContain('Здравствуйте! С радостью помогу.');
    expect(html).not.toContain('Сохранить стиль');
    expect(html).toContain('disabled=""');
  });
});
