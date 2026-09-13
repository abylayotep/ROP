/**
 * Public legal documents: privacy policy, terms, data deletion instructions.
 *
 * They are served without sign-in because Meta App Review and the customers of our
 * businesses must be able to open them. `?lang=en` selects English so Meta can be given
 * a stable English URL; Russian is the default.
 */
import { dataDeletion } from './data-deletion';
import { privacy } from './privacy';
import { terms } from './terms';
import type { LegalLang, LegalPageId, LegalTranslations } from './types';

export type { LegalBlock, LegalDocument, LegalLang, LegalPageId, LegalSection } from './types';

export const LEGAL_DOCUMENTS: Record<LegalPageId, LegalTranslations> = {
  privacy,
  terms,
  'data-deletion': dataDeletion,
};

/** Order of the pages in the cross-links at the top of each document. */
export const LEGAL_PAGE_IDS: LegalPageId[] = ['privacy', 'terms', 'data-deletion'];

export const EFFECTIVE_DATE: Record<LegalLang, string> = {
  ru: '13 сентября 2026 г.',
  en: '13 September 2026',
};

/** Chrome around the documents: labels that are not part of any one page. */
export const LEGAL_UI: Record<LegalLang, { effective: string; nav: Record<LegalPageId, string>; back: string }> = {
  ru: {
    effective: 'Дата вступления в силу',
    nav: { privacy: 'Конфиденциальность', terms: 'Условия', 'data-deletion': 'Удаление данных' },
    back: 'Ракурс',
  },
  en: {
    effective: 'Effective date',
    nav: { privacy: 'Privacy', terms: 'Terms', 'data-deletion': 'Data deletion' },
    back: 'Rakurs',
  },
};

export function legalLang(search: URLSearchParams): LegalLang {
  return search.get('lang') === 'en' ? 'en' : 'ru';
}

export function legalPath(page: LegalPageId, lang: LegalLang): string {
  return lang === 'en' ? `/${page}?lang=en` : `/${page}`;
}
