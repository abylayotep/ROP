import { ProposalWorkspace } from '@/components/knowledge/ProposalWorkspace';
import type { KbGenerationProposal, KbGenerationRunDetail } from '@/types';

/**
 * Compatibility boundary for callers that still use the previous component name.
 * Selection now comes exclusively from each proposal's persisted `selected` field.
 */
export function GenerationReview({
  agentId,
  detail,
  onChanged,
  readOnly = false,
}: {
  agentId: string;
  detail: KbGenerationRunDetail;
  onChanged: (proposal: KbGenerationProposal) => void;
  readOnly?: boolean;
}) {
  return <ProposalWorkspace agentId={agentId} detail={detail} onChanged={onChanged} readOnly={readOnly} />;
}
