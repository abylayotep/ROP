import { and, desc, eq, inArray, notLike } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, kbDrafts, kbGenerationProposals, kbGenerationRuns } from '../../db/schema.js';
import type { ModelClient } from '../ai/openrouter.js';
import { keyAad } from '../ai/turn.js';
import { decryptSecret } from '../secret-box.js';
import {
  consolidateGenerationProposals,
  GenerationConsolidationError,
  planGenerationTopics,
  type ConsolidationUsage,
  type RawGenerationProposal,
} from './generation-consolidate.js';
import { LEGACY_RAW_FINGERPRINT_PATTERN, type GenerationStoredSource } from './generation-types.js';
import {
  agentNotes,
  draftedProposals,
  isWhatsAppDraftTitle,
  loadExistingTopics,
  notePathOf,
  openWhatsAppDrafts,
  toNoteOp,
  writeWhatsAppDraft,
  type DraftEntry,
} from './whatsapp-drafts.js';

export interface RegroupDeps {
  model: ModelClient;
  credentialsKey: Buffer;
  log: (line: string) => void;
}

export interface RegroupAgentResult {
  agentId: string;
  outcome: 'dry_run' | 'written' | 'skipped';
  /** Why nothing was written; `null` for a dry run and a write. */
  reason: string | null;
  beforeOps: number;
  /** Findings consolidated: open drafts' note ops plus the `--source-draft` ops they did not already hold. */
  findings: number;
  /** Topic paths with how many findings each collects: planned on a dry run, written otherwise. */
  topics: RegroupTopic[];
  /** Findings no topic took: planned on a dry run, written otherwise. */
  dropped: number;
  usage: ConsolidationUsage;
}

export interface RegroupTopic {
  path: string;
  findings: number;
}

export interface RegroupOptions {
  agentId?: string;
  dryRun: boolean;
  /**
   * Drafts of any status whose note ops are consolidated too, deduplicated by exact path and body
   * against the open drafts' ops: recovers content an earlier regroup dropped. Only proposals
   * linked to open drafts are repointed; a source draft's proposals stay as they are.
   */
  sourceDraftIds?: string[];
}

const noUsage = (): ConsolidationUsage => ({ promptTokens: 0, completionTokens: 0, cost: '0' });

/** The key a drafted proposal points at: which op of which draft. */
const opRef = (draftId: string, index: number): string => `${draftId}:${index}`;

/**
 * One-off: rewrites the open chat drafts made before topic notes («… из WhatsApp», one note per
 * phrase) into the one «Обучение из переписки» draft of topic notes, by running today's
 * consolidation over their ops (plus the ops of any `sourceDraftIds`). A dry run runs only the
 * cheap assign step and prints which topic each finding would go to and how many are dropped; a
 * write runs both steps. Every proposal of an op a topic cites moves to that topic and
 * stays «drafted»; proposals of ops the model dropped go back to «pending» in their run.
 *
 * The model call happens outside any transaction. The write then locks the agent's drafts and
 * gives up on that agent when they changed in between, so a generation drafted meanwhile is
 * never overwritten. Usage is logged, not recorded against any run.
 */
export async function regroupWhatsAppDrafts(
  db: Db,
  deps: RegroupDeps,
  options: RegroupOptions,
): Promise<RegroupAgentResult[]> {
  const openRows = await db.select({ agentId: kbDrafts.agentId, title: kbDrafts.title }).from(kbDrafts)
    .where(eq(kbDrafts.status, 'open'));
  const sourceDrafts = options.sourceDraftIds && options.sourceDraftIds.length > 0
    ? await db.select().from(kbDrafts).where(inArray(kbDrafts.id, [...new Set(options.sourceDraftIds)]))
    : [];
  const missing = (options.sourceDraftIds ?? []).filter((id) => !sourceDrafts.some((draft) => draft.id === id));
  if (missing.length > 0) deps.log(`source drafts not found: ${missing.join(', ')}`);
  const agentIds = [...new Set([
    ...openRows.filter((row) => isWhatsAppDraftTitle(row.title)).map((row) => row.agentId),
    ...sourceDrafts.map((draft) => draft.agentId),
  ].filter((id) => options.agentId === undefined || id === options.agentId))];

  const results: RegroupAgentResult[] = [];
  for (const agentId of agentIds) {
    const sources = sourceDrafts.filter((draft) => draft.agentId === agentId);
    const result = await regroupAgent(db, deps, agentId, options.dryRun, sources);
    const tokens = `${result.usage.promptTokens}/${result.usage.completionTokens} tokens, cost ${result.usage.cost}`;
    deps.log(`agent ${agentId}: ${result.beforeOps} ops, ${result.findings} findings → ${result.topics.length} topics, ${result.dropped} dropped (${result.outcome}${result.reason ? `: ${result.reason}` : ''}; ${tokens})`);
    for (const topic of result.topics) deps.log(`  ${topic.path} ← ${topic.findings} findings`);
    results.push(result);
  }
  return results;
}

type DraftRow = typeof kbDrafts.$inferSelect;

async function regroupAgent(
  db: Db,
  deps: RegroupDeps,
  agentId: string,
  dryRun: boolean,
  sourceDrafts: DraftRow[],
): Promise<RegroupAgentResult> {
  const outcome = (
    kind: RegroupAgentResult['outcome'],
    reason: string | null,
    rest: Partial<RegroupAgentResult> = {},
  ): RegroupAgentResult => ({
    agentId, outcome: kind, reason, beforeOps: 0, findings: 0, topics: [], dropped: 0, usage: noUsage(), ...rest,
  });

  const [agent] = await db.select({
    openrouterKey: agents.openrouterKey,
    communicationStyle: agents.communicationStyle,
    temperature: agents.temperature,
  }).from(agents).where(eq(agents.id, agentId));
  if (!agent?.openrouterKey) return outcome('skipped', 'missing_ai_configuration');
  let key: string;
  try {
    key = decryptSecret(agent.openrouterKey, deps.credentialsKey, keyAad(agentId));
  } catch {
    return outcome('skipped', 'invalid_ai_configuration');
  }
  // The temperature the agent's last analysis used; consolidation picks its own fixed model.
  const [lastRun] = await db.select({ temperature: kbGenerationRuns.temperature })
    .from(kbGenerationRuns).where(eq(kbGenerationRuns.agentId, agentId))
    .orderBy(desc(kbGenerationRuns.createdAt)).limit(1);

  const drafts = await openWhatsAppDrafts(db, agentId, false);
  const notes = await agentNotes(db, agentId);
  const linked = await draftedProposals(db, drafts.map((draft) => draft.id));
  const raw: RawGenerationProposal[] = [];
  const refOfRaw = new Map<string, string>();
  const seen = new Set<string>();
  let beforeOps = 0;
  for (const draft of drafts) {
    draft.ops.forEach((op, index) => {
      beforeOps += 1;
      const path = notePathOf(op, notes);
      if (path === null || !('body' in op)) return;
      const ref = opRef(draft.id, index);
      const rows = linked.filter((row) => row.draftId === draft.id && row.draftOpIndex === index);
      const sources = new Map<string, GenerationStoredSource>();
      for (const source of rows.flatMap((row) => row.sources)) sources.set(`${source.conversationId}\n${source.messageId}`, source);
      const id = `op-${raw.length + 1}`;
      refOfRaw.set(id, ref);
      seen.add(`${path}\n${op.body}`);
      raw.push({
        id,
        kind: path.startsWith('Скрипт/') ? 'script' : 'knowledge',
        path,
        body: op.body,
        warnings: [...new Set(rows.flatMap((row) => row.warnings))],
        sources: [...sources.values()],
      });
    });
  }
  const openIds = new Set(drafts.map((draft) => draft.id));
  const extraDrafts = sourceDrafts.filter((draft) => !openIds.has(draft.id));
  const extraSources = await sourceDraftSources(db, agentId, extraDrafts);
  for (const draft of extraDrafts) {
    draft.ops.forEach((op, index) => {
      const path = notePathOf(op, notes);
      if (path === null || !('body' in op)) return;
      const key = `${path}\n${op.body}`;
      if (seen.has(key)) return;
      seen.add(key);
      const found = extraSources.get(opRef(draft.id, index)) ?? extraSources.get(key);
      raw.push({
        id: `source-${raw.length + 1}`,
        kind: path.startsWith('Скрипт/') ? 'script' : 'knowledge',
        path,
        body: op.body,
        warnings: found?.warnings ?? [],
        sources: found?.sources ?? [],
      });
    });
  }
  if (raw.length === 0) return outcome('skipped', 'no_note_ops', { beforeOps });
  const findings = raw.length;

  const consolidationDeps = {
    model: deps.model,
    key,
    temperature: lastRun?.temperature ?? agent.temperature,
  };
  const consolidationInput = {
    proposals: raw,
    communicationStyle: agent.communicationStyle,
    existingTopics: await loadExistingTopics(db, agentId, false),
  };
  let items;
  let usage: ConsolidationUsage;
  let dropped: number;
  try {
    if (dryRun) {
      const plan = await planGenerationTopics(consolidationDeps, consolidationInput);
      const topics = plan.topics.map((topic) => ({ path: topic.path, findings: topic.proposalIds.length }));
      return outcome('dry_run', null, {
        beforeOps, findings, topics, dropped: plan.droppedProposalIds.length, usage: plan.usage,
      });
    }
    const result = await consolidateGenerationProposals(consolidationDeps, consolidationInput);
    items = result.items;
    usage = result.usage;
    dropped = result.dropped;
  } catch (error) {
    if (error instanceof GenerationConsolidationError) {
      return outcome('skipped', `consolidation_${error.code}`, { beforeOps, findings, usage: error.usage });
    }
    throw error;
  }
  const topics = items.map((item) => ({ path: item.path, findings: new Set(item.sourceProposalIds).size }));
  if (items.length === 0) return outcome('skipped', 'no_topics', { beforeOps, findings, dropped, usage });

  const written = await db.transaction(async (tx) => {
    const lockedDb = tx as unknown as Db;
    const locked = await openWhatsAppDrafts(lockedDb, agentId, true);
    const sameDrafts = locked.length === drafts.length &&
      locked.every((draft, index) => draft.id === drafts[index]!.id);
    if (!sameDrafts) return false;

    const freshNotes = await agentNotes(lockedDb, agentId);
    const freshLinked = await draftedProposals(lockedDb, locked.map((draft) => draft.id));
    const proposalsOfRef = new Map<string, string[]>();
    for (const row of freshLinked) {
      const ref = opRef(row.draftId!, row.draftOpIndex ?? -1);
      proposalsOfRef.set(ref, [...(proposalsOfRef.get(ref) ?? []), row.id]);
    }

    // A proposal cited by two topics belongs to the first one: it has one op index.
    const assigned = new Set<string>();
    const take = (ref: string | undefined): string[] => (ref === undefined ? [] : proposalsOfRef.get(ref) ?? []).filter((id) => {
      if (assigned.has(id)) return false;
      assigned.add(id);
      return true;
    });
    const entries: DraftEntry[] = items.map((item) => ({
      op: toNoteOp({ op: 'note_create', path: item.path, body: item.body }, freshNotes),
      // A `--source-draft` finding has no ref: its proposals are not repointed.
      proposalIds: [...new Set(item.sourceProposalIds)].flatMap((id) => take(refOfRaw.get(id))),
    }));
    // Chat drafts hold only note ops, but anything else in them is carried over untouched.
    for (const draft of locked) {
      draft.ops.forEach((op, index) => {
        if (op.op === 'note_create' || op.op === 'note_update') return;
        entries.push({ op, proposalIds: take(opRef(draft.id, index)) });
      });
    }
    await writeWhatsAppDraft(lockedDb, {
      agentId,
      userId: null,
      openDrafts: locked,
      entries,
      newProposalIds: new Set(),
      released: freshLinked.map((row) => row.id).filter((id) => !assigned.has(id)),
    });
    return true;
  });
  return written
    ? outcome('written', null, { beforeOps, findings, topics, dropped, usage })
    : outcome('skipped', 'drafts_changed', { beforeOps, findings, topics, dropped, usage });
}

/**
 * Sources and warnings for the ops of `--source-draft` drafts, so the business-contact rule can
 * see which conversations a finding came from. Keyed by op ref (proposals still pointing at that
 * op, any status) and by exact `path
body` (the agent's proposals with the same text).
 */
async function sourceDraftSources(
  db: Db,
  agentId: string,
  drafts: DraftRow[],
): Promise<Map<string, { sources: GenerationStoredSource[]; warnings: RawGenerationProposal['warnings'] }>> {
  const found = new Map<string, { sources: GenerationStoredSource[]; warnings: RawGenerationProposal['warnings'] }>();
  if (drafts.length === 0) return found;
  const rows = await db.select({
    draftId: kbGenerationProposals.draftId,
    draftOpIndex: kbGenerationProposals.draftOpIndex,
    path: kbGenerationProposals.path,
    body: kbGenerationProposals.body,
    warnings: kbGenerationProposals.warnings,
    sources: kbGenerationProposals.sources,
  }).from(kbGenerationProposals)
    .innerJoin(kbGenerationRuns, eq(kbGenerationRuns.id, kbGenerationProposals.runId))
    .where(and(
      eq(kbGenerationRuns.agentId, agentId),
      notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
    ));
  const add = (key: string, row: (typeof rows)[number]) => {
    const entry = found.get(key) ?? { sources: [], warnings: [] };
    for (const source of row.sources) {
      if (!entry.sources.some((known) => known.conversationId === source.conversationId && known.messageId === source.messageId)) {
        entry.sources.push(source);
      }
    }
    entry.warnings = [...new Set([...entry.warnings, ...row.warnings])];
    found.set(key, entry);
  };
  const draftIds = new Set(drafts.map((draft) => draft.id));
  for (const row of rows) {
    if (row.draftId !== null && draftIds.has(row.draftId) && row.draftOpIndex !== null) add(opRef(row.draftId, row.draftOpIndex), row);
    add(`${row.path}\n${row.body}`, row);
  }
  return found;
}
