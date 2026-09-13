/** Shapes of the public legal documents. Text lives in the per-page modules beside this file. */

export type LegalLang = 'ru' | 'en';

export type LegalPageId = 'privacy' | 'terms' | 'data-deletion';

/**
 * One block of body text. Plain strings only: `LegalPage` turns `https://…` URLs and the
 * support bot handle into links, so the content modules never carry markup.
 */
export type LegalBlock =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'steps'; items: string[] };

export interface LegalSection {
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDocument {
  title: string;
  /** Paragraphs shown under the title, before the first section. */
  intro: string[];
  sections: LegalSection[];
}

export type LegalTranslations = Record<LegalLang, LegalDocument>;

export const p = (text: string): LegalBlock => ({ kind: 'p', text });
export const list = (...items: string[]): LegalBlock => ({ kind: 'list', items });
export const steps = (...items: string[]): LegalBlock => ({ kind: 'steps', items });
