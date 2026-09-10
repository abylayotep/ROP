import type { RuleCategory } from '../ai/rules.js';

/** One write a draft would make. A note operation goes through the editor's own save path. */
export type DraftOp =
  | { op: 'note_create'; path: string; body: string }
  | { op: 'note_update'; noteId: string; body: string }
  | { op: 'rule_create'; category: RuleCategory; text: string; warning?: string | null }
  | { op: 'rule_update'; ruleId: string; text?: string; enabled?: boolean };

/**
 * The `updatedAt` of everything the ops touch, as ISO strings, taken when the draft was made.
 *
 * A draft is a promise that what was tested is what lands. This is how the promise is checked:
 * a note edited underneath the draft makes it false, and applying anyway would put an untested
 * change into the store the agent answers from.
 */
export interface DraftBase {
  notes?: Record<string, string>;
  rules?: Record<string, string>;
}
