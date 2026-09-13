/** Shapes stored in `draft_autopilots`' jsonb columns. Log and failure text is Russian: the
 * owner reads it. */

export type AutopilotLogKind = 'info' | 'fix' | 'remove' | 'warn';

export interface AutopilotLogEntry {
  at: string;
  kind: AutopilotLogKind;
  text: string;
}

export interface FailingCase {
  title: string;
  messages: string[];
  before: string | null;
  after: string | null;
  reason: string | null;
}

export interface PendingFix {
  /** Stable topic key: `path:<path>` for `note_create`, `note:<noteId>` for `note_update`. */
  key: string;
  action: 'rewrite' | 'remove';
  cases: FailingCase[];
}
