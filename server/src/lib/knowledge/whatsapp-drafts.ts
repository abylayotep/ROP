import { and, asc, eq, inArray, like, notLike, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, kbDrafts, kbGenerationDrafts, kbGenerationProposals } from '../../db/schema.js';
import { baseOf, type DraftBase, type DraftOp } from '../drafts/ops.js';
import { LEGACY_RAW_FINGERPRINT_PATTERN } from './generation-types.js';

/**
 * Chat generation keeps at most ONE open draft per kind for an agent: one knowledge-base draft
 * and one sales-script draft. A new generation does not add a second draft next to the first;
 * it rebuilds the single draft from everything still open plus the new proposals.
 *
 * The rules, in order:
 * 1. Every open draft of the kind (older duplicates included) is read, oldest first.
 * 2. Its ops are replayed in that order, then the new ops. When two ops write the same note
 *    (same path for a create, same note id for an update), the newer one wins and the older
 *    proposal goes back to «pending» in its run.
 * 3. The old drafts are discarded and one fresh draft is created. A fresh draft, not an edited
 *    one, because a test run proves a specific set of ops: the merged draft must be tested again.
 */
export const WHATSAPP_DRAFT_KINDS = [
  { kind: 'knowledge', title: 'База знаний из WhatsApp' },
  { kind: 'script', title: 'Скрипт продаж из WhatsApp' },
] as const;

export type WhatsAppDraftKind = (typeof WHATSAPP_DRAFT_KINDS)[number]['kind'];

/** Matches the current title and the older «… · N» titles that counted the ops. */
const isKindTitle = (title: string, kindTitle: string): boolean =>
  title === kindTitle || title.startsWith(`${kindTitle} · `);

const opKey = (op: DraftOp): string => {
  if (op.op === 'note_create') return `path:${op.path.trim().toLocaleLowerCase('ru')}`;
  if (op.op === 'note_update') return `note:${op.noteId}`;
  return `other:${JSON.stringify(op)}`;
};

export interface NewDraftEntry {
  op: DraftOp;
  proposalId: string;
}

interface Entry {
  op: DraftOp;
  proposalIds: string[];
}

/**
 * Rebuilds the single open draft of `kind` with `newEntries` on top. Returns the draft id, or
 * `null` when there is nothing to put in a draft. Must run inside the caller's transaction.
 * `request`, when given, links the draft to the run and request that produced `newEntries`.
 */
export async function rebuildWhatsAppDraft(
  tx: Db,
  input: {
    agentId: string;
    userId: string | null;
    kind: WhatsAppDraftKind;
    newEntries: NewDraftEntry[];
    request?: { runId: string; requestKey: string };
  },
): Promise<string | null> {
  const { agentId, kind, newEntries } = input;
  const kindTitle = WHATSAPP_DRAFT_KINDS.find((item) => item.kind === kind)!.title;

  // Two generations of one agent finishing at once would each see "no draft yet" and each create one.
  await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update');
  const openDrafts = (await tx.select().from(kbDrafts).where(and(
    eq(kbDrafts.agentId, agentId),
    eq(kbDrafts.status, 'open'),
    eq(kbDrafts.origin, 'manual'),
  )).orderBy(asc(kbDrafts.createdAt), asc(kbDrafts.id)).for('update'))
    .filter((draft) => isKindTitle(draft.title, kindTitle));
  const oldDraftIds = openDrafts.map((draft) => draft.id);

  // Nothing new and at most one draft already: it is the single draft, leave it alone.
  if (newEntries.length === 0 && openDrafts.length <= 1) return openDrafts[0]?.id ?? null;

  const linkedProposals = oldDraftIds.length === 0 ? [] : await tx.select({
    id: kbGenerationProposals.id,
    draftId: kbGenerationProposals.draftId,
    draftOpIndex: kbGenerationProposals.draftOpIndex,
  }).from(kbGenerationProposals).where(and(
    inArray(kbGenerationProposals.draftId, oldDraftIds),
    eq(kbGenerationProposals.status, 'drafted'),
    notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
  ));

  // Newer op for the same note replaces the older one; `delete` first so it moves to the end.
  const entries = new Map<string, Entry>();
  const superseded: string[] = [];
  const put = (entry: Entry) => {
    const key = opKey(entry.op);
    const previous = entries.get(key);
    if (previous) superseded.push(...previous.proposalIds);
    entries.delete(key);
    entries.set(key, entry);
  };
  for (const draft of openDrafts) {
    draft.ops.forEach((op, index) => put({
      op,
      proposalIds: linkedProposals.filter((row) => row.draftId === draft.id && row.draftOpIndex === index).map((row) => row.id),
    }));
  }
  for (const entry of newEntries) put({ op: entry.op, proposalIds: [entry.proposalId] });

  const finalEntries = [...entries.values()];
  const ops = finalEntries.map((entry) => entry.op);
  const base = mergeBases(await baseOf(tx, agentId, ops), openDrafts.map((draft) => draft.base));

  if (oldDraftIds.length > 0) {
    await tx.update(kbDrafts).set({ status: 'discarded' }).where(inArray(kbDrafts.id, oldDraftIds));
  }
  if (superseded.length > 0) {
    await tx.update(kbGenerationProposals).set({
      status: 'pending',
      selected: false,
      draftId: null,
      draftOpIndex: null,
      revision: sql`${kbGenerationProposals.revision} + 1`,
      updatedAt: new Date(),
    }).where(inArray(kbGenerationProposals.id, superseded));
  }
  if (ops.length === 0) return null;

  const [draft] = await tx.insert(kbDrafts).values({
    agentId,
    title: kindTitle,
    origin: 'manual',
    ops,
    base,
    createdBy: input.userId ?? openDrafts.at(-1)?.createdBy ?? null,
  }).returning({ id: kbDrafts.id });
  const draftId = draft!.id;

  // The current request's link first, so its request key wins over an older one from the same run.
  if (input.request) {
    await tx.insert(kbGenerationDrafts).values({ draftId, ...input.request });
  }
  const oldLinks = oldDraftIds.length === 0 ? [] : await tx.select({
    runId: kbGenerationDrafts.runId,
    requestKey: kbGenerationDrafts.requestKey,
  }).from(kbGenerationDrafts).where(inArray(kbGenerationDrafts.draftId, oldDraftIds))
    .orderBy(sql`${kbGenerationDrafts.createdAt} desc`);
  if (oldLinks.length > 0) {
    await tx.insert(kbGenerationDrafts).values(oldLinks.map((link) => ({ draftId, ...link }))).onConflictDoNothing();
  }

  const newProposalIds = new Set(newEntries.map((entry) => entry.proposalId));
  for (let index = 0; index < finalEntries.length; index += 1) {
    for (const proposalId of finalEntries[index]!.proposalIds) {
      await tx.update(kbGenerationProposals).set({
        draftId,
        draftOpIndex: index,
        // Only a newly drafted proposal changes state; a moved one keeps its revision.
        ...(newProposalIds.has(proposalId) ? {
          status: 'drafted' as const,
          selected: false,
          revision: sql`${kbGenerationProposals.revision} + 1`,
          updatedAt: new Date(),
        } : {}),
      }).where(and(
        eq(kbGenerationProposals.id, proposalId),
        notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
      ));
    }
  }
  return draftId;
}

/** A note edited since the oldest draft was made must still read as stale, so the oldest
 * snapshot of a note wins over the fresh one. */
function mergeBases(fresh: DraftBase, older: DraftBase[]): DraftBase {
  const base: DraftBase = { ...fresh, notes: { ...fresh.notes }, noteNames: { ...fresh.noteNames } };
  for (const old of [...older].reverse()) {
    for (const [noteId, updatedAt] of Object.entries(old.notes ?? {})) {
      if (fresh.notes?.[noteId] === undefined) continue;
      base.notes![noteId] = updatedAt;
      if (old.noteNames?.[noteId] !== undefined) base.noteNames![noteId] = old.noteNames[noteId]!;
    }
  }
  if (Object.keys(base.notes!).length === 0) delete base.notes;
  if (Object.keys(base.noteNames!).length === 0) delete base.noteNames;
  return base;
}

/**
 * Collapses the duplicate WhatsApp drafts left by generations made before the one-draft rule.
 * Idempotent: an agent with one draft per kind is left as it is. Returns how many agents changed.
 */
export async function mergeDuplicateWhatsAppDrafts(db: Db): Promise<number> {
  const rows = await db.selectDistinct({ agentId: kbDrafts.agentId }).from(kbDrafts)
    .where(and(eq(kbDrafts.status, 'open'), eq(kbDrafts.origin, 'manual'), like(kbDrafts.title, '% из WhatsApp%')));
  let changed = 0;
  for (const { agentId } of rows) {
    const merged = await db.transaction(async (tx) => {
      let any = false;
      for (const { kind } of WHATSAPP_DRAFT_KINDS) {
        const before = await openCount(tx as unknown as Db, agentId);
        await rebuildWhatsAppDraft(tx as unknown as Db, { agentId, userId: null, kind, newEntries: [] });
        if ((await openCount(tx as unknown as Db, agentId)) !== before) any = true;
      }
      return any;
    });
    if (merged) changed += 1;
  }
  return changed;
}

async function openCount(db: Db, agentId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(kbDrafts)
    .where(and(eq(kbDrafts.agentId, agentId), eq(kbDrafts.status, 'open')));
  return row!.count;
}
