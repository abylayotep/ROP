import type { CoachProposal } from '@/types';

/** Keep the approved target and metadata while replacing only the field the owner can edit. */
export function proposalWithText(proposal: CoachProposal, text: string): CoachProposal {
  switch (proposal.kind) {
    case 'rule': return { ...proposal, text };
    case 'rule_edit': return { ...proposal, text };
    case 'note': return { ...proposal, body: text };
    case 'note_edit': return { ...proposal, body: text };
  }
}

/** A reload that already contains the local text needs no further reconciliation. */
export function needsProposalReconciliation(localText: string, savedText: string): boolean {
  return localText !== savedText;
}

/** Recompute on each edit: matching the reloaded server text resolves an earlier conflict. */
export function hasUnresolvedProposalConflict(conflict: boolean, localText: string, savedText: string): boolean {
  return conflict && needsProposalReconciliation(localText, savedText);
}
