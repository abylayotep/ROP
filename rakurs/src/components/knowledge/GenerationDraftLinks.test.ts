import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { expect, it } from 'vitest';
import { GenerationDraftLinks } from './GenerationDraftLinks';

const render = (drafts: { id: string; title: string }[]) => renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/knowledge' },
  createElement(GenerationDraftLinks, { drafts })));

it('links to both generated drafts without requiring proposal pagination', () => {
  const html = render([{ id: 'knowledge', title: 'База знаний из WhatsApp · 4' }, { id: 'script', title: 'Скрипт продаж из WhatsApp · 4' }]);
  expect(html).toContain('drafts/knowledge');
  expect(html).toContain('drafts/script');
  expect(html).toContain('Ничего не опубликовано');
});

it('explains an absent script instead of claiming both drafts were created', () => {
  expect(render([{ id: 'knowledge', title: 'База знаний из WhatsApp' }])).toContain('Новый черновик скрипта не создан');
});
