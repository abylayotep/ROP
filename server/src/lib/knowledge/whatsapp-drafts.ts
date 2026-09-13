import { and, asc, eq, inArray, notLike, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, kbDrafts, kbGenerationDrafts, kbGenerationProposals, kbNotes } from '../../db/schema.js';
import { baseOf, type DraftBase, type DraftOp } from '../drafts/ops.js';
import type { ExistingTopic } from './generation-consolidate.js';
import { TOPIC_PATH_PREFIX } from './generation-path.js';
import { LEGACY_RAW_FINGERPRINT_PATTERN } from './generation-types.js';

/**
 * Chat generation keeps ONE open draft per agent, «Обучение из переписки», holding one knowledge
 * note per customer topic. A new generation does not add a second draft next to the first; it
 * rebuilds the single draft from everything still open plus the new proposals.
 *
 * The rules, in order:
 * 1. Every open chat draft (older duplicates and the two legacy per-kind drafts included) is
 *    read, oldest first.
 * 2. A `note_create` whose path already names a note of the agent becomes a `note_update` of
 *    that note: two notes cannot share a path.
 * 3. Its ops are replayed in that order, then the new ops. When two ops write the same note
 *    (same path for a create, same note id for an update), the newer one wins. The older op's
 *    proposals move to the newer entry and stay «drafted»: consolidation writes a topic's full
 *    merged body, so the newer text already carries what they contributed.
 * 4. The old drafts are discarded and one fresh draft is created. A fresh draft, not an edited
 *    one, because a test run proves a specific set of ops: the merged draft must be tested again.
 */
export const WHATSAPP_DRAFT_TITLE = 'Обучение из переписки';

/** The per-kind drafts made before topic notes; still absorbed into the one draft. */
export const LEGACY_WHATSAPP_DRAFT_TITLES = ['База знаний из WhatsApp', 'Скрипт продаж из WhatsApp'] as const;

/** Matches the current title, the legacy ones, and the older «… · N» titles that counted the ops. */
export const isWhatsAppDraftTitle = (title: string): boolean =>
  [WHATSAPP_DRAFT_TITLE, ...LEGACY_WHATSAPP_DRAFT_TITLES].some((known) =>
    title === known || title.startsWith(`${known} · `));

const pathKey = (path: string): string => path.trim().toLocaleLowerCase('ru');

type DraftRow = typeof kbDrafts.$inferSelect;

/** Open chat drafts of the agent, oldest first. `lock` also takes the agent row, which is what
 * serializes two generations finishing at once: each would otherwise see "no draft yet". */
export async function openWhatsAppDrafts(tx: Db, agentId: string, lock: boolean): Promise<DraftRow[]> {
  if (lock) await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update');
  const query = tx.select().from(kbDrafts).where(and(
    eq(kbDrafts.agentId, agentId),
    eq(kbDrafts.status, 'open'),
    eq(kbDrafts.origin, 'manual'),
  )).orderBy(asc(kbDrafts.createdAt), asc(kbDrafts.id));
  return (await (lock ? query.for('update') : query)).filter((draft) => isWhatsAppDraftTitle(draft.title));
}

/** Proposals still drafted into `draftIds`, with what regrouping needs to rebuild a finding. */
export async function draftedProposals(tx: Db, draftIds: string[]) {
  if (draftIds.length === 0) return [];
  return tx.select({
    id: kbGenerationProposals.id,
    draftId: kbGenerationProposals.draftId,
    draftOpIndex: kbGenerationProposals.draftOpIndex,
    warnings: kbGenerationProposals.warnings,
    sources: kbGenerationProposals.sources,
  }).from(kbGenerationProposals).where(and(
    inArray(kbGenerationProposals.draftId, draftIds),
    eq(kbGenerationProposals.status, 'drafted'),
    notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
  ));
}

/** Every note of the agent, by id and by lowercased path. */
export async function agentNotes(tx: Db, agentId: string) {
  const rows = await tx.select({ id: kbNotes.id, path: kbNotes.path, body: kbNotes.body })
    .from(kbNotes).where(eq(kbNotes.agentId, agentId)).orderBy(asc(kbNotes.path));
  return {
    rows,
    byId: new Map(rows.map((note) => [note.id, note])),
    byPath: new Map(rows.map((note) => [pathKey(note.path), note])),
  };
}

type AgentNotes = Awaited<ReturnType<typeof agentNotes>>;

/** A create for a path that already names a note would collide on apply; it updates that note. */
export const toNoteOp = (op: DraftOp, notes: AgentNotes): DraftOp => {
  if (op.op !== 'note_create') return op;
  const note = notes.byPath.get(pathKey(op.path));
  return note ? { op: 'note_update', noteId: note.id, body: op.body } : op;
};

/** The path a note op writes: its own for a create, the note's current one for an update. */
export const notePathOf = (op: DraftOp, notes: AgentNotes): string | null => {
  if (op.op === 'note_create') return op.path;
  if (op.op === 'note_update') return notes.byId.get(op.noteId)?.path ?? null;
  return null;
};

/**
 * The topics consolidation merges into: notes under «База знаний/» and, when `withDrafts`, the
 * note ops of the open chat draft on top of them (a draft op carries the newer body).
 */
export async function loadExistingTopics(db: Db, agentId: string, withDrafts: boolean): Promise<ExistingTopic[]> {
  const notes = await agentNotes(db, agentId);
  const topics = new Map<string, ExistingTopic>();
  for (const note of notes.rows) {
    if (note.path.startsWith(TOPIC_PATH_PREFIX)) topics.set(pathKey(note.path), { path: note.path, body: note.body });
  }
  if (withDrafts) {
    for (const draft of await openWhatsAppDrafts(db, agentId, false)) {
      for (const op of draft.ops) {
        const path = notePathOf(op, notes);
        if (path === null || !path.startsWith(TOPIC_PATH_PREFIX) || !('body' in op)) continue;
        const key = pathKey(path);
        topics.delete(key);
        topics.set(key, { path, body: op.body });
      }
    }
  }
  return [...topics.values()];
}

const opKey = (op: DraftOp): string => {
  if (op.op === 'note_create') return `path:${pathKey(op.path)}`;
  if (op.op === 'note_update') return `note:${op.noteId}`;
  return `other:${JSON.stringify(op)}`;
};

export interface NewDraftEntry {
  op: DraftOp;
  proposalId: string;
}

export interface DraftEntry {
  op: DraftOp;
  proposalIds: string[];
}

/**
 * Rebuilds the single open chat draft with `newEntries` on top. Returns the draft id, or `null`
 * when there is nothing to put in a draft. Must run inside the caller's transaction.
 * `request`, when given, links the draft to the run and request that produced `newEntries`.
 */
export async function rebuildWhatsAppDraft(
  tx: Db,
  input: {
    agentId: string;
    userId: string | null;
    newEntries: NewDraftEntry[];
    request?: { runId: string; requestKey: string };
  },
): Promise<string | null> {
  const { agentId, newEntries } = input;
  const openDrafts = await openWhatsAppDrafts(tx, agentId, true);

  // Nothing new and at most one draft already: it is the single draft, leave it alone.
  if (newEntries.length === 0 && openDrafts.length <= 1) return openDrafts[0]?.id ?? null;

  const linked = await draftedProposals(tx, openDrafts.map((draft) => draft.id));
  const notes = await agentNotes(tx, agentId);

  // Newer op for the same note replaces the older one and takes over its proposals;
  // `delete` first so it moves to the end.
  const entries = new Map<string, DraftEntry>();
  const put = (entry: DraftEntry) => {
    const op = toNoteOp(entry.op, notes);
    const key = opKey(op);
    const previous = entries.get(key);
    entries.delete(key);
    entries.set(key, { op, proposalIds: [...(previous?.proposalIds ?? []), ...entry.proposalIds] });
  };
  for (const draft of openDrafts) {
    draft.ops.forEach((op, index) => put({
      op,
      proposalIds: linked.filter((row) => row.draftId === draft.id && row.draftOpIndex === index).map((row) => row.id),
    }));
  }
  for (const entry of newEntries) put({ op: entry.op, proposalIds: [entry.proposalId] });

  return writeWhatsAppDraft(tx, {
    agentId,
    userId: input.userId,
    openDrafts,
    entries: [...entries.values()],
    newProposalIds: new Set(newEntries.map((entry) => entry.proposalId)),
    released: [],
    request: input.request,
  });
}

/**
 * Replaces `openDrafts` with one fresh draft of `entries`. Proposals in `newProposalIds` become
 * «drafted»; every other listed proposal only moves to its entry's index. `released` proposals
 * go back to «pending» in their run. Must run inside the caller's transaction.
 */
export async function writeWhatsAppDraft(
  tx: Db,
  input: {
    agentId: string;
    userId: string | null;
    openDrafts: DraftRow[];
    entries: DraftEntry[];
    newProposalIds: Set<string>;
    released: string[];
    request?: { runId: string; requestKey: string };
  },
): Promise<string | null> {
  const { agentId, openDrafts, entries, newProposalIds } = input;
  const oldDraftIds = openDrafts.map((draft) => draft.id);
  const ops = entries.map((entry) => entry.op);
  const base = mergeBases(await baseOf(tx, agentId, ops), openDrafts.map((draft) => draft.base));

  if (oldDraftIds.length > 0) {
    await tx.update(kbDrafts).set({ status: 'discarded' }).where(inArray(kbDrafts.id, oldDraftIds));
  }
  if (input.released.length > 0) {
    await tx.update(kbGenerationProposals).set({
      status: 'pending',
      selected: false,
      draftId: null,
      draftOpIndex: null,
      revision: sql`${kbGenerationProposals.revision} + 1`,
      updatedAt: new Date(),
    }).where(inArray(kbGenerationProposals.id, input.released));
  }
  if (ops.length === 0) return null;

  const [draft] = await tx.insert(kbDrafts).values({
    agentId,
    title: WHATSAPP_DRAFT_TITLE,
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

  for (let index = 0; index < entries.length; index += 1) {
    for (const proposalId of entries[index]!.proposalIds) {
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
