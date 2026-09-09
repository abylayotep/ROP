/**
 * The check that keeps a fact out of `agent_rules`.
 *
 * `docs/ai-agent.md` says the number guard in `turn.ts` is the one promise this product keeps
 * in code rather than in a prompt: a price the agent states must appear in a section it cited,
 * in the customer's own words, or in the owner's instructions. That promise has a hole the
 * moment a coach can write straight into a rule — a rule is read into `assembleRules` and
 * becomes part of «the owner's instructions», one of the guard's own three sources, so a price
 * the coach invented would be accepted by the guard with nothing behind it. This file is what
 * closes that hole: before a coaching proposal ever reaches a draft, a `rule` or `rule_edit`
 * proposal that states a number nothing in this agent's vault or rules already states is
 * rewritten into a `note` instead, where it belongs until a person has actually seen it.
 *
 * ## Why `unsourcedNumber` and not a second scanner
 *
 * `turn.ts` exports `unsourcedNumber` for exactly this reason: the check that moves a rule
 * into a note and the check that refuses a reply have to agree about the same digits, because
 * a rule this check let through becomes one of the guard's own sources on the very next turn.
 * Two independent readers of "is this number known" would eventually read a phone number or a
 * range differently, and the gap between them is a fact that passes here and fails there, or
 * — worse — the other way round.
 *
 * ## What counts as "already known"
 *
 * Every chunk this agent's vault holds, and every *enabled* rule's text. Not "the records a
 * reply cited": a coaching proposal has no citation to check against, unlike a customer-facing
 * reply, so the only honest question is whether the number appears anywhere in what the agent
 * has been given, not in the narrow slice one particular answer drew from. And not a disabled
 * rule's text: a rule the owner has switched off is not read into `assembleRules` and is not a
 * source the number guard itself would ever credit — a number backed only by a disabled rule
 * is, for every purpose the guard cares about, backed by nothing, and treating it as known here
 * would let a coach reintroduce a number that was turned off for a reason nobody logged.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agentRules, kbChunks, kbNotes } from '../../db/schema.js';
import type { CoachProposal } from './coach.js';
import { unsourcedNumber } from './turn.js';

/** Every chunk's text and every enabled rule's text — see the file comment for why. */
async function knownSources(db: Db, agentId: string): Promise<string[]> {
  const chunks = await db
    .select({ content: kbChunks.content })
    .from(kbChunks)
    .where(eq(kbChunks.agentId, agentId));
  const rules = await db
    .select({ text: agentRules.text })
    .from(agentRules)
    .where(and(eq(agentRules.agentId, agentId), eq(agentRules.enabled, true)));
  return [...chunks.map((row) => row.content), ...rules.map((row) => row.text)];
}

/** How much of a rule's first line becomes the note's name. */
const PATH_TITLE_LIMIT = 80;

/**
 * A path under `Прочее/` that no note of this agent already holds.
 *
 * The brief's own suggestion — `Прочее/<first line>` — collides the moment two proposals
 * share an opening line, or the owner has already written a note there by hand. Neither
 * failure is rare: "Доставка по Алматы 1500 ₸." is exactly the kind of sentence a coach
 * converts more than once. Silently overwriting whatever already lives at that path would
 * lose a note nobody asked to lose, and letting the collision reach `saveNote`'s own unique
 * index would fail the whole approval instead of the one thing that needed rewriting — so the
 * free path is found here, before either can happen.
 */
async function freeNotePath(db: Db, agentId: string, base: string): Promise<string> {
  const rows = await db.select({ path: kbNotes.path }).from(kbNotes).where(eq(kbNotes.agentId, agentId));
  const taken = new Set(rows.map((row) => row.path));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The rule text a proposal carries, or `undefined` when there is none to check. */
function ruleText(proposal: CoachProposal): string | undefined {
  if (proposal.kind === 'rule') return proposal.text;
  if (proposal.kind === 'rule_edit') return proposal.text;
  return undefined;
}

/**
 * Checks a coaching proposal against what this agent's vault and rules already know, and
 * rewrites it into a note when it fails.
 *
 * Only `rule` and `rule_edit` proposals are checked — see the file comment — and only when
 * they carry text at all: a `rule_edit` that merely toggles `enabled` states no fact and has
 * nothing to check. `note` and `note_edit` proposals pass through untouched: a note is where a
 * fact belongs, and where the fact-check's job ends.
 */
export async function checkProposal(
  db: Db,
  agentId: string,
  proposal: CoachProposal,
): Promise<{ proposal: CoachProposal; warning: string | null }> {
  const text = ruleText(proposal);
  if (text === undefined || text.trim() === '') return { proposal, warning: null };

  const sources = await knownSources(db, agentId);
  const invented = unsourcedNumber(text, sources);
  if (invented === null) return { proposal, warning: null };

  const firstLine = (text.split('\n')[0] ?? '').trim().slice(0, PATH_TITLE_LIMIT) || text.slice(0, PATH_TITLE_LIMIT);
  const path = await freeNotePath(db, agentId, `Прочее/${firstLine}`);

  return {
    proposal: { kind: 'note', path, body: text },
    warning:
      `В правиле есть число «${invented}», которого нет в базе знаний — оно должно быть заметкой`,
  };
}
