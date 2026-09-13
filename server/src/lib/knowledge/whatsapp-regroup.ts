import { desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, kbDrafts, kbGenerationRuns } from '../../db/schema.js';
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
import type { GenerationStoredSource } from './generation-types.js';
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
  /** Topic paths with how many ops each collects: planned on a dry run, written otherwise. */
  topics: RegroupTopic[];
  usage: ConsolidationUsage;
}

export interface RegroupTopic {
  path: string;
  ops: number;
}

const noUsage = (): ConsolidationUsage => ({ promptTokens: 0, completionTokens: 0, cost: '0' });

/** The key a drafted proposal points at: which op of which draft. */
const opRef = (draftId: string, index: number): string => `${draftId}:${index}`;

/**
 * One-off: rewrites the open chat drafts made before topic notes («… из WhatsApp», one note per
 * phrase) into the one «Обучение из переписки» draft of topic notes, by running today's
 * consolidation over their ops. A dry run runs only the cheap assign step and prints which topic
 * each op would go to; a write runs both steps. Every proposal of an op a topic cites moves to that topic and
 * stays «drafted»; proposals of ops the model dropped go back to «pending» in their run.
 *
 * The model call happens outside any transaction. The write then locks the agent's drafts and
 * gives up on that agent when they changed in between, so a generation drafted meanwhile is
 * never overwritten. Usage is logged, not recorded against any run.
 */
export async function regroupWhatsAppDrafts(
  db: Db,
  deps: RegroupDeps,
  options: { agentId?: string; dryRun: boolean },
): Promise<RegroupAgentResult[]> {
  const openRows = await db.select({ agentId: kbDrafts.agentId, title: kbDrafts.title }).from(kbDrafts)
    .where(eq(kbDrafts.status, 'open'));
  const agentIds = [...new Set(openRows
    .filter((row) => isWhatsAppDraftTitle(row.title))
    .map((row) => row.agentId)
    .filter((id) => options.agentId === undefined || id === options.agentId))];

  const results: RegroupAgentResult[] = [];
  for (const agentId of agentIds) {
    const result = await regroupAgent(db, deps, agentId, options.dryRun);
    const tokens = `${result.usage.promptTokens}/${result.usage.completionTokens} tokens, cost ${result.usage.cost}`;
    deps.log(`agent ${agentId}: ${result.beforeOps} ops → ${result.topics.length} topics (${result.outcome}${result.reason ? `: ${result.reason}` : ''}; ${tokens})`);
    for (const topic of result.topics) deps.log(`  ${topic.path} ← ${topic.ops} ops`);
    results.push(result);
  }
  return results;
}

async function regroupAgent(db: Db, deps: RegroupDeps, agentId: string, dryRun: boolean): Promise<RegroupAgentResult> {
  const outcome = (
    kind: RegroupAgentResult['outcome'],
    reason: string | null,
    rest: Partial<RegroupAgentResult> = {},
  ): RegroupAgentResult => ({ agentId, outcome: kind, reason, beforeOps: 0, topics: [], usage: noUsage(), ...rest });

  const [agent] = await db.select({
    openrouterKey: agents.openrouterKey,
    communicationStyle: agents.communicationStyle,
    model: agents.model,
    temperature: agents.temperature,
  }).from(agents).where(eq(agents.id, agentId));
  if (!agent?.openrouterKey) return outcome('skipped', 'missing_ai_configuration');
  let key: string;
  try {
    key = decryptSecret(agent.openrouterKey, deps.credentialsKey, keyAad(agentId));
  } catch {
    return outcome('skipped', 'invalid_ai_configuration');
  }
  // The model and temperature the agent's last analysis used; a new run takes the agent's own.
  const [lastRun] = await db.select({ modelId: kbGenerationRuns.modelId, temperature: kbGenerationRuns.temperature })
    .from(kbGenerationRuns).where(eq(kbGenerationRuns.agentId, agentId))
    .orderBy(desc(kbGenerationRuns.createdAt)).limit(1);

  const drafts = await openWhatsAppDrafts(db, agentId, false);
  const notes = await agentNotes(db, agentId);
  const linked = await draftedProposals(db, drafts.map((draft) => draft.id));
  const raw: RawGenerationProposal[] = [];
  const refOfRaw = new Map<string, string>();
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
  if (raw.length === 0) return outcome('skipped', 'no_note_ops', { beforeOps });

  const consolidationDeps = {
    model: deps.model,
    key,
    modelId: lastRun?.modelId ?? agent.model,
    temperature: lastRun?.temperature ?? agent.temperature,
  };
  const consolidationInput = {
    proposals: raw,
    communicationStyle: agent.communicationStyle,
    existingTopics: await loadExistingTopics(db, agentId, false),
  };
  let items;
  let usage: ConsolidationUsage;
  try {
    if (dryRun) {
      const plan = await planGenerationTopics(consolidationDeps, consolidationInput);
      const topics = plan.topics.map((topic) => ({ path: topic.path, ops: topic.proposalIds.length }));
      return outcome('dry_run', null, { beforeOps, topics, usage: plan.usage });
    }
    const result = await consolidateGenerationProposals(consolidationDeps, consolidationInput);
    items = result.items;
    usage = result.usage;
  } catch (error) {
    if (error instanceof GenerationConsolidationError) {
      return outcome('skipped', `consolidation_${error.code}`, { beforeOps, usage: error.usage });
    }
    throw error;
  }
  const topics = items.map((item) => ({ path: item.path, ops: new Set(item.sourceProposalIds).size }));
  if (items.length === 0) return outcome('skipped', 'no_topics', { beforeOps, usage });

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
    const take = (ref: string): string[] => (proposalsOfRef.get(ref) ?? []).filter((id) => {
      if (assigned.has(id)) return false;
      assigned.add(id);
      return true;
    });
    const entries: DraftEntry[] = items.map((item) => ({
      op: toNoteOp({ op: 'note_create', path: item.path, body: item.body }, freshNotes),
      proposalIds: [...new Set(item.sourceProposalIds)].flatMap((id) => take(refOfRaw.get(id)!)),
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
    ? outcome('written', null, { beforeOps, topics, usage })
    : outcome('skipped', 'drafts_changed', { beforeOps, topics, usage });
}
