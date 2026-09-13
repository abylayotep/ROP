import type {
  KbGenerationPreview,
  KbGenerationProposal,
  KbGenerationRunDetail,
  KbGenerationSelection,
} from '@/types';

export interface GenerationUiState {
  selection: KbGenerationSelection;
  preview: KbGenerationPreview | null;
  detail: KbGenerationRunDetail | null;
  selectedProposalIds: string[];
}

export type GenerationUiAction =
  | { type: 'selection'; selection: KbGenerationSelection }
  | { type: 'preview'; preview: KbGenerationPreview }
  | { type: 'run_requested' }
  | { type: 'run'; detail: KbGenerationRunDetail }
  | { type: 'poll'; detail: KbGenerationRunDetail }
  | { type: 'select_proposal'; proposalId: string; selected: boolean }
  | { type: 'proposal_updated'; proposal: KbGenerationProposal }
  | { type: 'append_page'; detail: KbGenerationRunDetail; collection?: GenerationDetailCollection }
  | { type: 'reset' };

export type GenerationDetailCollection = 'proposals' | 'drafts' | 'exclusions' | 'rawFindings';

export const initialGenerationState = (selection: KbGenerationSelection): GenerationUiState => ({
  selection,
  preview: null,
  detail: null,
  selectedProposalIds: [],
});

/** Pure transitions keep polling from erasing explicit owner choices. */
export function reduceGenerationState(
  state: GenerationUiState,
  action: GenerationUiAction,
): GenerationUiState {
  switch (action.type) {
    case 'selection':
      return initialGenerationState(action.selection);
    case 'preview':
      return { ...state, preview: action.preview, detail: null, selectedProposalIds: [] };
    case 'run_requested':
      return { ...state, preview: null, detail: null, selectedProposalIds: [] };
    case 'run':
      return { ...state, detail: action.detail, selectedProposalIds: [] };
    case 'poll':
      return { ...state, detail: action.detail };
    case 'select_proposal':
      return {
        ...state,
        selectedProposalIds: action.selected
          ? [...new Set([...state.selectedProposalIds, action.proposalId])]
          : state.selectedProposalIds.filter((id) => id !== action.proposalId),
      };
    case 'proposal_updated':
      return state.detail === null ? state : {
        ...state,
        detail: {
          ...state.detail,
          proposals: {
            ...state.detail.proposals,
            items: state.detail.proposals.items.map((proposal) =>
              proposal.id === action.proposal.id && action.proposal.revision >= proposal.revision
                ? action.proposal
                : proposal),
          },
        },
      };
    case 'append_page': {
      if (state.detail === null || state.detail.run.id !== action.detail.run.id) return state;
      return {
        ...state,
        detail: appendGenerationDetailPage(state.detail, action.detail, action.collection ?? 'proposals'),
      };
    }
    case 'reset':
      return initialGenerationState(state.selection);
  }
}

export type GenerationView = 'selection' | 'preview' | 'active' | 'empty' | 'partial_failure' | 'review' | 'cancelled';

export function generationView(state: GenerationUiState): GenerationView {
  const run = state.detail?.run;
  if (!run) return state.preview ? 'preview' : 'selection';
  if (run.status === 'queued' || run.status === 'running') return 'active';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'failed') return run.proposalCount > 0 ? 'partial_failure' : 'review';
  return run.proposalCount === 0 ? 'empty' : 'review';
}

/** A late response may update only the run and selection epoch that started it. */
export const isCurrentGenerationResponse = (
  startedEpoch: number,
  responseRunId: string,
  currentEpoch: number,
  currentRunId: string | null,
): boolean => startedEpoch === currentEpoch && responseRunId === currentRunId;

/** Refreshes changed first-page rows without throwing away pages the owner already loaded. */
export function mergeRefreshedGenerationDetail(
  current: KbGenerationRunDetail,
  refreshed: KbGenerationRunDetail,
): KbGenerationRunDetail {
  const stableTerminal = current.run.status === refreshed.run.status && isTerminalGenerationStatus(current.run.status);
  if (!stableTerminal) {
    const currentById = new Map(current.proposals.items.map((proposal) => [proposal.id, proposal]));
    return {
      ...refreshed,
      proposals: {
        ...refreshed.proposals,
        items: refreshed.proposals.items.map((proposal) => {
          const existing = currentById.get(proposal.id);
          return existing && existing.revision > proposal.revision ? existing : proposal;
        }),
      },
    };
  }
  return {
    ...refreshed,
    proposals: {
      items: mergeProposals(current.proposals.items, refreshed.proposals.items),
      nextCursor: current.proposals.nextCursor,
    },
    drafts: mergeReplacingByKey(current.drafts ?? [], refreshed.drafts ?? [], (draft) => draft.id),
    draftsNextCursor: current.draftsNextCursor === undefined ? refreshed.draftsNextCursor : current.draftsNextCursor,
    exclusions: mergeByKey(current.exclusions ?? [], refreshed.exclusions ?? [], (exclusion) => exclusion.batchId),
    exclusionsNextCursor: current.exclusionsNextCursor === undefined ? refreshed.exclusionsNextCursor : current.exclusionsNextCursor,
    ...(current.rawFindings !== undefined ? {
      rawFindings: mergeByKey(current.rawFindings, refreshed.rawFindings ?? [], (finding) => finding.id),
      rawFindingsNextCursor: current.rawFindingsNextCursor,
    } : {}),
  };
}

function isTerminalGenerationStatus(status: KbGenerationRunDetail['run']['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function appendGenerationDetailPage(
  current: KbGenerationRunDetail,
  next: KbGenerationRunDetail,
  collection: GenerationDetailCollection,
): KbGenerationRunDetail {
  const base = { ...current, run: next.run };
  switch (collection) {
    case 'proposals':
      return {
        ...base,
        proposals: {
          items: mergeProposals(current.proposals.items, next.proposals.items),
          nextCursor: next.proposals.nextCursor,
        },
      };
    case 'drafts':
      return {
        ...base,
        drafts: mergeReplacingByKey(current.drafts, next.drafts, (draft) => draft.id),
        draftsNextCursor: next.draftsNextCursor,
      };
    case 'exclusions':
      return {
        ...base,
        exclusions: mergeByKey(current.exclusions, next.exclusions, (exclusion) => exclusion.batchId),
        exclusionsNextCursor: next.exclusionsNextCursor,
      };
    case 'rawFindings':
      return {
        ...base,
        rawFindings: mergeByKey(current.rawFindings ?? [], next.rawFindings ?? [], (finding) => finding.id),
        rawFindingsNextCursor: next.rawFindingsNextCursor,
      };
  }
}

function mergeProposals(
  current: readonly KbGenerationProposal[],
  next: readonly KbGenerationProposal[],
): KbGenerationProposal[] {
  const items = [...current];
  const indexById = new Map(items.map((proposal, index) => [proposal.id, index]));
  for (const proposal of next) {
    const index = indexById.get(proposal.id);
    if (index === undefined) {
      indexById.set(proposal.id, items.length);
      items.push(proposal);
    } else if (proposal.revision > items[index]!.revision) {
      items[index] = proposal;
    }
  }
  return items;
}

function mergeByKey<T>(current: readonly T[], next: readonly T[], key: (item: T) => string): T[] {
  const items = [...current];
  const seen = new Set(items.map(key));
  for (const item of next) {
    if (seen.has(key(item))) continue;
    seen.add(key(item));
    items.push(item);
  }
  return items;
}

function mergeReplacingByKey<T>(current: readonly T[], next: readonly T[], key: (item: T) => string): T[] {
  const items = [...current];
  const indexByKey = new Map(items.map((item, index) => [key(item), index]));
  for (const item of next) {
    const index = indexByKey.get(key(item));
    if (index === undefined) {
      indexByKey.set(key(item), items.length);
      items.push(item);
    } else {
      items[index] = item;
    }
  }
  return items;
}
