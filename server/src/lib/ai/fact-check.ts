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
 *
 * ## Why `enabled: true` alone is enough to trigger a check
 *
 * A `rule_edit { ruleId, enabled: true }` carries no `text` of its own, but applying it reads
 * the *target rule's* text into `assembleRules` on the very next turn — exactly the same
 * reintroduction `knownSources` refuses to credit a disabled rule for. Checking only a
 * proposal's own `text` field and calling anything else "nothing to check" would let a coach
 * walk straight around the rule above: turn a price rule back on and the guard accepts it with
 * nothing behind it, because nobody re-checked the number the rule has carried all along. So
 * `effectiveText` below reads the target rule's current text for this one case, the same text
 * `assembleRules` would read if the edit were applied unchanged.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agentRules, kbChunks, kbNotes } from '../../db/schema.js';
import { isUuid } from '../uuid.js';
import type { CoachProposal } from './coach.js';
import { unsourcedNumber } from './turn.js';

/** A model may name an edit target only when it belongs to this agent. A factual correction
 * additionally narrows note edits to notes actually cited by the selected response. */
export async function ownsProposalTarget(db: Db, agentId: string, proposal: CoachProposal,
  citedNoteIds?: readonly string[]): Promise<boolean> {
  if (proposal.kind === 'rule' || proposal.kind === 'note') return true;
  if (proposal.kind === 'rule_edit') {
    if (!isUuid(proposal.ruleId)) return false;
    const [row] = await db.select({ id: agentRules.id }).from(agentRules)
      .where(and(eq(agentRules.id, proposal.ruleId), eq(agentRules.agentId, agentId)));
    return row !== undefined;
  }
  if (!isUuid(proposal.noteId) ||
      (citedNoteIds !== undefined && !citedNoteIds.includes(proposal.noteId))) return false;
  const [row] = await db.select({ id: kbNotes.id }).from(kbNotes)
    .where(and(eq(kbNotes.id, proposal.noteId), eq(kbNotes.agentId, agentId)));
  return row !== undefined;
}

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

/** How much of a rule's first line becomes the note's name. Applied after the slash mapping
 * below, not before: mapping first means a cut can never land on a slash and leave a
 * trailing one, which `notePath`'s own validation in `api/knowledge.ts` refuses. */
const PATH_TITLE_LIMIT = 80;

/**
 * A path under `Прочее/` that no note of this agent already holds, at the moment this check
 * runs.
 *
 * The brief's own suggestion — `Прочее/<first line>` — collides the moment two proposals
 * share an opening line, or the owner has already written a note there by hand. Neither
 * failure is rare: "Доставка по Алматы 1500 ₸." is exactly the kind of sentence a coach
 * converts more than once. Silently overwriting whatever already lives at that path would
 * lose a note nobody asked to lose, and letting the collision reach `saveNote`'s own unique
 * index would fail the whole approval instead of the one thing that needed rewriting — so the
 * free path is found here, checked against every note that exists right now.
 *
 * That narrows the window a collision can happen in; it does not close it. A checked proposal
 * is not an applied one — nothing here writes `kb_notes` — so two proposals built from the
 * same opening line before either is approved both see the same path free, and both are handed
 * back the identical candidate. Closing that the rest of the way is the approval path's job
 * (`saveNote`'s own unique index refuses the second write), not this probe's.
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

/** The rule text a proposal carries on its own, or `undefined` when it carries none. */
function ownText(proposal: CoachProposal): string | undefined {
  if (proposal.kind === 'rule') return proposal.text;
  if (proposal.kind === 'rule_edit') return proposal.text;
  return undefined;
}

/**
 * The rule text this proposal would make part of `assembleRules` if applied unchanged — what
 * `checkProposal` actually has to check.
 *
 * A `rule` or a `rule_edit` carrying its own non-blank `text` is checked on that text, same as
 * always — `ownText` alone answers it, no query needed. An *empty or whitespace-only* `text` on
 * a `rule_edit` is treated the same as no `text` field at all: the zod schema allows `text: ''`
 * through, but a blank string names no text of its own any more than an absent field does, so
 * it falls through to the same fallback below rather than short-circuiting `checkProposal` on a
 * blank string (the hole a re-review found: `{ ruleId, text: '', enabled: true }` used to skip
 * the check entirely because `'' !== undefined`).
 *
 * A `rule_edit { enabled: true }` with no text of its own (blank or absent) is checked on the
 * *target rule's current text* instead — see the file comment's "Why `enabled: true` alone is
 * enough to trigger a check". `ruleId` is model-written and never validated before it reaches
 * here, so it is checked against `isUuid` first: `agent_rules.id` is a `uuid` column, and
 * querying it with text that is not a uuid raises Postgres `22P02` instead of returning no row,
 * which would 500 the whole coaching turn on a hallucinated id. A non-uuid `ruleId` names no
 * rule, so it is treated exactly like a `ruleId` that is a well-formed uuid but matches no row:
 * nothing to check. Anything else (a `rule_edit` that only disables) has nothing to check and
 * returns `undefined`, same as before.
 */
async function effectiveText(db: Db, agentId: string, proposal: CoachProposal): Promise<string | undefined> {
  const own = ownText(proposal);
  if (own !== undefined && own.trim() !== '') return own;
  if (proposal.kind !== 'rule_edit' || proposal.enabled !== true) return undefined;
  if (!isUuid(proposal.ruleId)) return undefined;

  const [row] = await db
    .select({ text: agentRules.text })
    .from(agentRules)
    .where(and(eq(agentRules.id, proposal.ruleId), eq(agentRules.agentId, agentId)));
  return row?.text;
}

/**
 * Checks a coaching proposal against what this agent's vault and rules already know, and
 * rewrites it into a note when it fails.
 *
 * Only `rule` and `rule_edit` proposals are checked — see the file comment — and only when
 * there is text to check: a `rule` or `rule_edit` carrying its own `text`, or a `rule_edit`
 * that turns a rule back on (checked against that rule's current text — see `effectiveText`).
 * A `rule_edit` that only disables a rule states no fact and has nothing to check. `note` and
 * `note_edit` proposals pass through untouched: a note is where a fact belongs, and where the
 * fact-check's job ends.
 *
 * When the number in question turns out to belong to a rule that already exists — the
 * `rule_edit { enabled: true }` case — this still rewrites the proposal into a `note` rather
 * than into, say, a `rule_edit` carrying a warning: the owner asked to reintroduce a number
 * nothing backs, and the answer is the same one a brand-new rule with the same number gets,
 * for the same reason (see the file comment). The rule this proposal named is left exactly as
 * disabled as it was — nothing here writes `agent_rules` — so re-enabling it is a decision the
 * owner makes again, deliberately, once the number either gets a record or the owner insists
 * through `agent_rules.warning` (POST /rules, once a later plan wires a writer to it).
 */
export async function checkProposal(
  db: Db,
  agentId: string,
  proposal: CoachProposal,
): Promise<{ proposal: CoachProposal; warning: string | null }> {
  const text = await effectiveText(db, agentId, proposal);
  if (text === undefined || text.trim() === '') return { proposal, warning: null };

  const sources = await knownSources(db, agentId);
  const invented = unsourcedNumber(text, sources);
  if (invented === null) return { proposal, warning: null };

  const firstLineRaw = (text.split('\n')[0] ?? '').trim() || text.trim();
  // A slash in the rule's own text would open a folder nobody asked for — `api/knowledge.ts`
  // meets the same problem mapping a page's title into a path and answers it the same way.
  // Mapped before the length cut below, not after: mapping first means the cut can never land
  // on a slash and leave a trailing one, which `notePath`'s own validation would then refuse.
  const firstLine = firstLineRaw.replace(/\//g, '∕').slice(0, PATH_TITLE_LIMIT);
  const path = await freeNotePath(db, agentId, `Прочее/${firstLine}`);

  return {
    proposal: { kind: 'note', path, body: text },
    warning:
      `В правиле есть число «${invented}», которого нет в базе знаний — оно должно быть заметкой`,
  };
}
