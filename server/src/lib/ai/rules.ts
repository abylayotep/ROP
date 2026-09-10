/**
 * The rules an agent follows, and the one string the prompt has always carried.
 *
 * `agents.instructions` used to be a paragraph the owner typed once. It is gone (migration
 * 0013), replaced by `agent_rules` — a row per rule, switchable and orderable on its own. This
 * file is the seam between the two: it reads the rows and hands back exactly the string
 * `PromptAgent.instructions` used to be, so `prompt.ts` and the number guard in `turn.ts` stay
 * unaware that anything changed underneath them.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agentRules } from '../../db/schema.js';
import type { RuleCategory } from './coach.js';

export type { RuleCategory };

export interface AgentRule {
  category: RuleCategory;
  text: string;
}

/**
 * The four groups, in the order the prompt shows them, with the words the agent reads.
 *
 * Order is fixed rather than data: it goes from what we are, through how we sound, to what we
 * must not do — and a rule that forbids something is worth the most when it is read last.
 */
const GROUPS: readonly { category: RuleCategory; heading: string }[] = [
  { category: 'business', heading: 'О компании' },
  { category: 'tone', heading: 'Как говорить' },
  { category: 'order', heading: 'О чём спрашивать' },
  { category: 'forbid', heading: 'Чего не делать' },
];

/**
 * The four categories, in the same order `assembleRules` renders them in — derived from
 * `GROUPS` rather than repeated, so a screen that lists an agent's rules by category (the
 * `GET /rules` route in `api/rules.ts`) shows the owner the sequence the prompt actually
 * reads, without a second table that could drift from this one.
 */
export const RULE_CATEGORY_ORDER: readonly RuleCategory[] = GROUPS.map((g) => g.category);

/**
 * The rules as one string, which is what the prompt has always carried.
 *
 * One string rather than a new prompt section, because the number guard verifies a number
 * against «the instructions» and that check must go on reading exactly what the model was
 * shown. A second shape here would be a second place for the two to drift apart.
 *
 * Grouping happens here, in the fixed order of `GROUPS`, regardless of what order the rules
 * arrive in — see `loadRules` for why its own SQL order does not have to (and does not)
 * match this one.
 */
export function assembleRules(rules: AgentRule[]): string {
  return GROUPS.map(({ category, heading }) => {
    const lines = rules.filter((rule) => rule.category === category);
    return lines.length === 0 ? '' : `${heading}\n${lines.map((r) => `- ${r.text}`).join('\n')}`;
  })
    .filter((block) => block !== '')
    .join('\n\n');
}

/**
 * The enabled rules of one agent, in the order the owner arranged them.
 *
 * Ordered by `category` then `position` to match `agent_rules_agent_category_idx` — the same
 * two columns, in the same order, so Postgres can walk the index instead of sorting. That
 * ordering is not the one `assembleRules` renders in (`GROUPS` fixes its own, unrelated
 * order): `assembleRules` re-groups every row by category from scratch, so all that matters
 * here is that rows sharing a category come back with `position` non-decreasing among
 * themselves — true whether the primary sort key is `category` or nothing at all. Sorting by
 * `category` first is free correctness insurance (it also keeps a same-category run
 * contiguous, which nothing downstream needs) that happens to line up with the index.
 */
export async function loadRules(db: Db, agentId: string): Promise<AgentRule[]> {
  const rows = await db
    .select({ category: agentRules.category, text: agentRules.text })
    .from(agentRules)
    .where(and(eq(agentRules.agentId, agentId), eq(agentRules.enabled, true)))
    .orderBy(asc(agentRules.category), asc(agentRules.position));
  return rows as AgentRule[];
}
