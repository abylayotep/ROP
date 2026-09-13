import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCUMENTS, LEGAL_PAGE_IDS, legalLang, legalPath } from './content';
import { LegalPage } from './LegalPage';

const render = (url: string, id: (typeof LEGAL_PAGE_IDS)[number]) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, createElement(LegalPage, { id })));

describe('legal documents', () => {
  it.each(LEGAL_PAGE_IDS)('%s has matching Russian and English structure', (id) => {
    const { ru, en } = LEGAL_DOCUMENTS[id];
    expect(ru.sections.length).toBeGreaterThan(0);
    expect(en.sections.length).toBe(ru.sections.length);
    ru.sections.forEach((section, index) => {
      expect(en.sections[index].blocks.map((block) => block.kind)).toEqual(section.blocks.map((block) => block.kind));
    });
  });

  it('leaves no unfilled template placeholders', () => {
    expect(JSON.stringify(LEGAL_DOCUMENTS)).not.toMatch(/\{\{\s*[A-Z_]+\s*\}\}/);
  });

  it('selects English only through ?lang=en', () => {
    expect(legalLang(new URLSearchParams('lang=en'))).toBe('en');
    expect(legalLang(new URLSearchParams('lang=de'))).toBe('ru');
    expect(legalLang(new URLSearchParams())).toBe('ru');
    expect(legalPath('privacy', 'en')).toBe('/privacy?lang=en');
    expect(legalPath('privacy', 'ru')).toBe('/privacy');
  });

  it('renders the requested language with the effective date and a contact link', () => {
    const ru = render('/data-deletion', 'data-deletion');
    expect(ru).toContain('Удаление данных');
    expect(ru).toContain('13 сентября 2026');
    expect(ru).toContain('href="https://t.me/tasbaqa_helper_bot"');

    const en = render('/privacy?lang=en', 'privacy');
    expect(en).toContain('Privacy Policy');
    expect(en).toContain('13 September 2026');
    expect(en).toContain('href="https://rop.tasbaqa.ru/data-deletion?lang=en"');
  });
});
