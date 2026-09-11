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
  | { type: 'run'; detail: KbGenerationRunDetail }
  | { type: 'poll'; detail: KbGenerationRunDetail }
  | { type: 'select_proposal'; proposalId: string; selected: boolean }
  | { type: 'proposal_updated'; proposal: KbGenerationProposal }
  | { type: 'append_page'; detail: KbGenerationRunDetail }
  | { type: 'reset' };

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
              proposal.id === action.proposal.id ? action.proposal : proposal),
          },
        },
      };
    case 'append_page': {
      if (state.detail === null || state.detail.run.id !== action.detail.run.id) return state;
      const items = [...state.detail.proposals.items];
      const indexById = new Map(items.map((proposal, index) => [proposal.id, index]));
      for (const proposal of action.detail.proposals.items) {
        const index = indexById.get(proposal.id);
        if (index === undefined) {
          indexById.set(proposal.id, items.length);
          items.push(proposal);
        } else if (proposal.revision > items[index]!.revision) {
          items[index] = proposal;
        }
      }
      return {
        ...state,
        detail: {
          ...action.detail,
          proposals: { items, nextCursor: action.detail.proposals.nextCursor },
        },
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
  const refreshedById = new Map(refreshed.proposals.items.map((proposal) => [proposal.id, proposal]));
  const currentIds = new Set(current.proposals.items.map((proposal) => proposal.id));
  return {
    ...refreshed,
    proposals: {
      items: [
        ...current.proposals.items.map((proposal) => refreshedById.get(proposal.id) ?? proposal),
        ...refreshed.proposals.items.filter((proposal) => !currentIds.has(proposal.id)),
      ],
      nextCursor: current.proposals.nextCursor,
    },
  };
}
