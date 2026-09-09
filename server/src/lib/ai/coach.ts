/**
 * Types the coaching schema needs before the coach itself exists.
 *
 * `agent_rules` and `coach_messages` (schema.ts) are added in the same migration that this
 * module's types support: `coach_messages.proposal` is branded `CoachProposal`, and Postgres
 * needs the shape at the type level the moment the column is declared. Task 4 of the coaching
 * plan adds the prompt builder and the OpenRouter call beside these types — until then this
 * file stays a leaf module with no imports, exactly the way `capi/events.ts` stays one for
 * `capi_events.payload`.
 */

/**
 * The four groups a rule can belong to.
 *
 * Declared here rather than in `lib/ai/rules.ts`, because `rules.ts` does not exist until
 * Task 2 and this type is needed the moment `CoachProposal` is. Task 2 imports it from here
 * instead of redeclaring it, so the category stays one type with one definition.
 */
export type RuleCategory = 'business' | 'tone' | 'order' | 'forbid';

/**
 * What the coach may suggest changing, and nothing more.
 *
 * The coach never writes `agent_rules` or `kb_notes` itself — this is the shape of the
 * suggestion it hands back, which becomes a draft only once the owner approves it. A rule
 * proposal names a category and text the way `POST /rules` does; the two note proposals are
 * a path and a body, exactly what `saveNote` takes.
 */
export type CoachProposal =
  | { kind: 'rule'; category: RuleCategory; text: string }
  | { kind: 'rule_edit'; ruleId: string; text?: string; enabled?: boolean }
  | { kind: 'note'; path: string; body: string }
  | { kind: 'note_edit'; noteId: string; body: string };
