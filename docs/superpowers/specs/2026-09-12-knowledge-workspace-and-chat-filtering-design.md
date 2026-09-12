# Knowledge Workspace and Chat Filtering Design

Date: 2026-09-12
Status: Approved

## Summary

Replace the current long, narrow Knowledge page with a wide review workspace. The workspace keeps every WhatsApp generation run visible, separates source import from review, lets an owner edit and select individual knowledge or script proposals, and never publishes generated content automatically.

Generation becomes a two-stage pipeline. It first rejects conversations that are not clearly customer-related, then consolidates grounded facts and sales language into concise review proposals. A persistent communication-style setting controls both generated scripts and live agent replies.

## Goals

- Keep an indefinitely paginated history of every generation run.
- Make the drafts created by each run obvious and directly accessible.
- Exclude chats with friends, the business itself, staff, suppliers, and unrelated businesses.
- Prefer false negatives over contaminating the knowledge base or sales script.
- Consolidate duplicate raw findings into a short, editable review list.
- Let the owner select, edit, reject, and inspect sources for every proposal.
- Apply the selected communication style to scripts and live AI replies.
- Make the page wide, compact, and easy to scan without a long vertical form.
- Preserve the existing rule that nothing is published without explicit review and application.

## Non-goals

- Automatically deleting old runs or drafts.
- Automatically applying knowledge or script changes.
- Training or fine-tuning a model.
- Inferring customer relevance from contact names or phone numbers alone.
- Hiding excluded chats so completely that the owner cannot audit the decision.

## Approved Product Direction

Use layout A, the wide three-column workspace:

1. Left: generation-run history.
2. Center: grouped proposals with selection and inline editing.
3. Right: communication style and draft shortcuts.

The page-level tabs are:

- `Знания`
- `Черновики`
- `Запуски`
- `Источники и загрузка`

The selected default communication style is `Живой и тёплый`:

- respectful `вы` / `сіз`;
- short natural sentences;
- zero to two relevant emoji per reply;
- no corporate filler, bureaucratic language, or robotic instructions;
- reply in the customer's language when it is Russian or Kazakh.

## User Experience

### Knowledge

Show published notes in a wide searchable list. Filters remain available, but creation and import forms do not appear below the list.

### Drafts

The left rail shows all runs, newest first. Selecting a run loads its review state without leaving the workspace.

The center column has `База знаний` and `Скрипт продаж` sub-tabs. Each consolidated proposal contains:

- selection checkbox;
- editable title or path;
- editable body;
- source count and source links;
- confidence or warning label;
- rejection action;
- explanation when the source conversation was excluded.

High-confidence, grounded proposals are selected by default. Uncertain, sensitive, internal, or rejected proposals remain unchecked. The owner can select all visible items or clear the selection.

`Собрать новый черновик` creates a review draft only from the checked proposals. It does not publish notes or change agent rules. A run may have more than one draft, and every created draft remains linked from that run.

### Runs

Every run remains stored and is shown with:

- creation time;
- status;
- selected and relevant conversation counts;
- processed batch count;
- proposal count;
- skipped and excluded counts;
- token usage and recorded cost;
- error summary;
- links to every resulting draft.

History is paginated and never automatically deleted. Preview records may still expire because completed runs retain their own immutable selection manifest.

### Sources and Upload

Move all import controls into one tab with compact source cards:

- WhatsApp history;
- Instagram;
- pasted text;
- web page.

Only the selected source card expands. This removes the current long stack of forms. WhatsApp connection and archive status remain visible inside its card.

### Communication Style

The right column shows three presets:

- `Живой и тёплый` (default);
- `Спокойный`;
- `Дружеский`.

The preset is stored per agent. A short preview demonstrates how the agent would answer. Saving a preset changes future script generation and future live replies, but never rewrites existing drafts.

## Relevance Classification

Each generation batch must return a classification before proposals:

```json
{
  "classification": {
    "value": "customer",
    "reason": "The customer asks about a product and delivery."
  },
  "proposals": []
}
```

Allowed values are:

- `customer`: clear discussion of the seller's product, service, order, payment, delivery, return, or customer support;
- `irrelevant`: friends, self-chat, staff, suppliers, unrelated businesses, casual conversation, or internal production coordination;
- `uncertain`: not enough evidence in the supplied messages.

The server accepts proposals only when classification is `customer`. `irrelevant` and `uncertain` produce no proposals. When a batch lacks both a customer-authored message and a seller-authored message, it is rejected before a paid model call.

The prompt must explicitly distinguish customer-facing sales language from internal instructions. Profanity, staff commands, personal names, customer addresses, phone numbers, and one-off personal promises are never reusable script content.

Classification and its short reason are stored with the batch so the owner can audit exclusions without rerunning the model.

## Consolidation

Raw per-chat findings are evidence, not the final draft. After extraction completes:

1. Split grounded findings into knowledge and script categories.
2. Remove exact duplicates deterministically.
3. Run bounded category consolidation to merge semantic duplicates and rewrite fragments.
4. Require every consolidated item to cite one or more accepted raw proposal IDs.
5. Map those proposal IDs back to immutable WhatsApp message sources.
6. Drop any consolidated item whose sources cannot be verified.

The final review list should contain concise reusable items rather than hundreds of message fragments. Raw findings remain available in a collapsed audit section.

Script consolidation must produce phrases an agent can send, not meta-instructions such as “tell the customer.” It must follow the saved communication style and remove rude, internal, or personally identifying language.

## Persistence

Extend generation batches with stored classification and reason fields. Associate generated drafts with their originating generation run through a durable relation that supports multiple drafts per run.

Store the communication-style preset on the agent. Existing agents default to `warm` so migration does not change behavior until the new prompts are deployed.

No migration deletes or rewrites existing runs, proposals, drafts, knowledge notes, or rules.

## API Changes

- Run-list endpoint: paginated run summaries with counts, cost, errors, and draft links.
- Run-detail endpoint: consolidated proposals, raw findings on demand, exclusions, and all drafts.
- Proposal update endpoint: optimistic revision checks for path/body edits.
- Proposal selection endpoint: persist checked state without creating a draft.
- Draft creation endpoint: create a draft from the current checked set.
- Agent-style endpoint: read and update the style preset and preview text.

All mutating endpoints remain tenant-scoped, idempotent where replay is possible, and reject stale revisions.

## Failure Handling

- Provider authentication, balance, and network failures stop the run with a clear actionable error.
- Malformed model output records usage, marks only that batch as skipped, and continues.
- A classification without valid evidence becomes `uncertain`.
- A proposal with missing or customer-only sources is dropped.
- Consolidation failure leaves grounded raw findings available for manual review.
- Draft creation is transactional and never partially creates a draft.
- Existing drafts remain open if a later run fails.

## Testing

Server regression coverage must prove:

- friend, self, staff, supplier, and unrelated-business examples produce no proposals;
- real product, order, payment, delivery, and support conversations remain eligible;
- uncertain classification defaults to exclusion;
- missing customer or seller side avoids a paid call;
- consolidation merges duplicates while retaining all valid sources;
- unsupported sources, personal data, and profanity cannot enter final proposals;
- every run and every associated draft remains queryable;
- proposal selection and editing are revision-safe;
- no generation action publishes notes or agent rules.

Frontend coverage must prove:

- run history is paginated and selectable;
- draft links are visible for every run;
- checkbox selection, select-all, editing, rejection, and draft creation work;
- tabs prevent the page from becoming one long form;
- the workspace remains usable at desktop and mobile breakpoints;
- style selection persists and changes the preview.

Production verification must use a real two-week WhatsApp run, confirm excluded-chat counts, inspect both new drafts, and confirm that published notes and agent rules remain unchanged.

## Rollout and Recovery

1. Add backward-compatible schema fields and relations.
2. Deploy read paths and the new workspace behind the existing Knowledge route.
3. Deploy relevance classification and consolidation.
4. Run focused tests and a production smoke test.
5. Generate new filtered drafts from the latest two weeks.
6. Keep the previous drafts open and clearly label them as earlier runs.

Rollback restores the previous application image. Additive schema changes remain harmless. No rollback deletes runs or drafts.

## Acceptance Criteria

- The owner can find every generation run and every draft from the Knowledge page.
- The page uses layout A and no longer stacks all import forms vertically.
- Unrelated conversations contribute zero knowledge or script proposals.
- The final review list is concise, sourced, editable, and selectable.
- The saved warm style affects both generated scripts and live replies.
- Nothing is published until the owner explicitly tests and applies a draft.
