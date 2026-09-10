/**
 * The four categories a rule can belong to, and the Russian heading each prints under.
 *
 * The order below is for a form's dropdown only — never for sorting an already-fetched
 * rules list. The order the model reads rules in is server-owned
 * (`RULE_CATEGORY_ORDER` in `server/src/lib/ai/rules.ts`) and `GET /rules` already answers
 * in it; a second array here that also claimed to be "the order" would drift from it the
 * moment the server's changed, silently, since nothing would notice the two disagreeing.
 */
import type { RuleCategory } from '@/types';

export const RULE_CATEGORIES: { id: RuleCategory; label: string }[] = [
  { id: 'business', label: 'О компании' },
  { id: 'tone', label: 'Как говорить' },
  { id: 'order', label: 'О чём спрашивать' },
  { id: 'forbid', label: 'Чего не делать' },
];

export const ruleCategoryLabel = (category: RuleCategory): string =>
  RULE_CATEGORIES.find((item) => item.id === category)?.label ?? category;

/**
 * The same heading, lowercased at the front — «Новое правило: чего не делать» reads as one
 * sentence, not a heading pasted after a colon.
 */
export const ruleCategoryPhrase = (category: RuleCategory): string => {
  const label = ruleCategoryLabel(category);
  return label.charAt(0).toLowerCase() + label.slice(1);
};
