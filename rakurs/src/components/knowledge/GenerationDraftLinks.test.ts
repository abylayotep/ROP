import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { expect, it } from 'vitest';
import { GenerationDraftLinks } from './GenerationDraftLinks';

const render = (drafts: { id: string; title: string }[]) => renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/knowledge' },
  createElement(GenerationDraftLinks, { drafts })));

it('links to the one chat-generation draft', () => {
  const html = render([{ id: 'other', title: 'Правка цен' }, { id: 'topics', title: 'Обучение из переписки' }]);
  expect(html).toContain('drafts/topics');
  expect(html).not.toContain('drafts/other');
  expect(html.match(/Открыть черновик/g)).toHaveLength(1);
  expect(html).toContain('Все отобранные темы собираются в один черновик');
});

it('prefers the new draft and falls back to a legacy one', () => {
  expect(render([{ id: 'legacy', title: 'Скрипт продаж из WhatsApp · 4' }, { id: 'topics', title: 'Обучение из переписки' }]))
    .toContain('drafts/topics');
  expect(render([{ id: 'legacy', title: 'База знаний из WhatsApp · 4' }])).toContain('drafts/legacy');
});

it('says no draft was made when nothing was picked', () => {
  const html = render([]);
  expect(html).not.toContain('drafts/');
  expect(html).toContain('Черновик не создан');
});
