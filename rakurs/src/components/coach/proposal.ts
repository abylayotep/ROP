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
