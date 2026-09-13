import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { visibleTabs } from '@/lib/training-routes';
import { TrainingWorkspace } from './TrainingScreen';

const render = (owner: boolean, reviewCount: number | null = null) => renderToStaticMarkup(createElement(TrainingWorkspace, {
  tabs: visibleTabs(owner),
  activeTab: 'knowledge',
  reviewCount,
  strip: createElement('p', { 'data-strip': 'yes' }, 'Next step'),
  onTabChange: () => undefined,
  children: createElement('p', null, 'Tab content'),
}));

describe('TrainingWorkspace', () => {
  it('shows the owner four tabs with the review count and marks the active one', () => {
    const html = render(true, 3);
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toContain('Знания');
    expect(html).toContain('Как отвечает');
    expect(html).toContain('Научить');
    expect(html).toContain('На проверке (3)');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Знания/);
    expect(html).toContain('role="tabpanel"');
  });

  it('shows a non-owner only the two read-only tabs', () => {
    const html = render(false);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).not.toContain('Научить');
    expect(html).not.toContain('На проверке');
  });

  it('titles the page and renders the strip above the tablist', () => {
    const html = render(true);
    expect(html).toContain('Обучение агента');
    const strip = html.indexOf('data-strip="yes"');
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(html.indexOf('role="tablist"'));
  });
});
