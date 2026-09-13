import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorNotifySettings } from '@/types';

const fixture = vi.hoisted(() => ({
  data: { phone: '77716944499' } as OperatorNotifySettings | undefined,
  error: undefined as unknown,
  reload: vi.fn(),
}));
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ ...fixture, loading: false }) }));
import { OperatorNotifyCard, operatorPhoneDisplay, saveOperatorNotify } from './OperatorNotifyCard';

beforeEach(() => {
  fixture.data = { phone: '77716944499' };
  fixture.error = undefined;
  fixture.reload.mockReset();
});

describe('OperatorNotifyCard', () => {
  it('shows the saved number, the explanation and the save button to the owner', () => {
    const html = renderToStaticMarkup(createElement(OperatorNotifyCard, { agentId: 'agent-1' }));
    expect(html).toContain('Уведомления оператору');
    expect(html).toContain('Номер WhatsApp оператора');
    expect(html).toContain('value="+77716944499"');
    expect(html).toContain('за последние 24 часа');
    expect(html).toContain('Сохранить номер');
  });

  it('keeps the number readable but immutable for members', () => {
    const html = renderToStaticMarkup(createElement(OperatorNotifyCard, { agentId: 'agent-1', readOnly: true }));
    expect(html).toContain('value="+77716944499"');
    expect(html).not.toContain('Сохранить номер');
    expect(html).toContain('disabled=""');
  });

  it('shows an empty field when nobody is notified', () => {
    fixture.data = { phone: null };
    const html = renderToStaticMarkup(createElement(OperatorNotifyCard, { agentId: 'agent-1' }));
    expect(html).toContain('value=""');
  });

  it('sends what the owner typed and lets the server normalize it', async () => {
    const update = vi.fn().mockResolvedValue({ phone: '77716944499' });
    await expect(saveOperatorNotify('agent-1', ' 8 771 694 44 99 ', update)).resolves.toEqual({ phone: '77716944499' });
    expect(update).toHaveBeenCalledWith('agent-1', '8 771 694 44 99');
    expect(operatorPhoneDisplay(null)).toBe('');
  });
});
