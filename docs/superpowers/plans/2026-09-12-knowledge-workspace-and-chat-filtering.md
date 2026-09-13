# Knowledge Workspace and Chat Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved wide Knowledge workspace, exclude non-customer WhatsApp chats, consolidate grounded proposals, persist review choices and run-to-draft history, and apply a natural communication style to generation and live replies.

**Architecture:** Extend the existing additive generation schema rather than replacing stored runs. The server performs deterministic eligibility checks, model classification, grounded extraction, and bounded consolidation before exposing a revision-safe review API; the React Knowledge route becomes a tabbed three-column workspace over those APIs. Communication style is stored on `agents` and injected into both generation and live-reply prompts.

**Tech Stack:** TypeScript, Fastify, Drizzle/PostgreSQL, React, React Router, Vitest, Testing Library, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-12-knowledge-workspace-and-chat-filtering-design.md`

## Global Constraints
- Preserve every existing generation run, proposal, draft, note, and rule.
- Prefer false negatives: only `customer` batches may create proposals.
- Never publish a note or agent rule from generation without explicit draft review and application.
- Keep each maintained Markdown file below 500 lines.
- Do not include unrelated Kaspi or parallel WhatsApp edits in task commits.
- Use additive migrations and keep rollback compatible with the previous application image.

## File Map
- `server/src/db/schema.ts`, `server/drizzle/0029_knowledge_review_workspace.sql`: additive persistence for classification, selection, proposal kind/confidence, run-draft links, and agent style.
- `packages/contract/index.ts`: shared API types for style, classified batches, proposal review state, exclusions, and draft links.
- `server/src/lib/knowledge/generation-extract.ts`: customer relevance classification and grounded raw extraction.
- `server/src/lib/knowledge/generation-consolidate.ts`: bounded deduplication and source-preserving consolidation.
- `server/src/lib/knowledge/generation-run.ts`: pipeline orchestration and durable metrics.
- `server/src/lib/knowledge/generation-review.ts`: optimistic edits, persisted selection, rejection, and transactional draft assembly.
- `server/src/api/knowledge-generation.ts`, `server/src/api/agents.ts`: paginated review/run APIs and style API.
- `server/src/lib/ai/prompt.ts`, `server/src/lib/ai/turn.ts`: live reply style injection.
- `rakurs/src/api/index.ts`: typed client methods.
- `rakurs/src/screens/KnowledgeScreen.tsx`, `rakurs/src/screens/knowledge-workspace.css`: route tabs and responsive wide layout.
- `rakurs/src/components/knowledge/KnowledgeWorkspace.tsx`: selected tab/run orchestration.
- `rakurs/src/components/knowledge/GenerationRunRail.tsx`: complete paginated run history.
- `rakurs/src/components/knowledge/ProposalWorkspace.tsx`: grouped proposal selection, editing, sources, and draft creation.
- `rakurs/src/components/knowledge/CommunicationStyleCard.tsx`: style presets and preview.
- `rakurs/src/components/knowledge/KnowledgeSourceCards.tsx`: compact, single-expanded import sources.

---

### Task 1: Add backward-compatible review persistence

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: `server/drizzle/0029_knowledge_review_workspace.sql`
- Modify: `server/drizzle/meta/_journal.json`
- Modify: `packages/contract/index.ts`
- Test: `server/test/knowledge-generation-workspace-schema.test.ts`

**Interfaces:**
- Produces: `CommunicationStyle = 'warm' | 'calm' | 'friendly'`.
- Produces: batch fields `classification`, `classificationReason`; proposal fields `kind`, `confidence`, `selected`; join table `kbGenerationDrafts(runId, draftId, createdAt)`.
- Produces: contract fields used by all later server and UI tasks.
- [ ] **Step 1: Write the failing schema and contract tests**

```ts
expect(getTableColumns(agents)).toHaveProperty('communicationStyle');
expect(getTableColumns(kbGenerationBatches)).toMatchObject({
  classification: expect.anything(), classificationReason: expect.anything(),
});
expect(getTableColumns(kbGenerationProposals)).toMatchObject({
  kind: expect.anything(), confidence: expect.anything(), selected: expect.anything(),
});
expect(getTableColumns(kbGenerationDrafts)).toMatchObject({ runId: expect.anything(), draftId: expect.anything() });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm --prefix server test -- knowledge-generation-workspace-schema.test.ts`
Expected: FAIL because the new columns and table do not exist.

- [ ] **Step 3: Add schema, migration, and contract types**

```ts
export type CommunicationStyle = 'warm' | 'calm' | 'friendly';
export type KbGenerationClassification = 'customer' | 'irrelevant' | 'uncertain';
export type KbGenerationProposalKind = 'knowledge' | 'script';
export type KbGenerationConfidence = 'high' | 'review';
```

Use `communication_style text not null default 'warm'`, nullable batch classification fields for historical rows, `selected boolean not null default false`, and a unique `(run_id, draft_id)` relation. Do not backfill or rewrite old proposal content.

- [ ] **Step 4: Run schema and migration tests**

Run: `npm --prefix server test -- knowledge-generation-workspace-schema.test.ts schema.test.ts knowledge-vault-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit only Task 1 files**

```bash
git add packages/contract/index.ts server/src/db/schema.ts server/drizzle/0029_knowledge_review_workspace.sql server/drizzle/meta/_journal.json server/test/knowledge-generation-workspace-schema.test.ts
git commit -m "feat: persist knowledge generation review state"
```

### Task 2: Classify conversations before accepting proposals

**Files:**
- Modify: `server/src/lib/knowledge/generation-extract.ts`
- Modify: `server/src/lib/knowledge/generation-types.ts`
- Modify: `server/src/lib/knowledge/generation-run.ts`
- Test: `server/test/knowledge-generation-extract.test.ts`
- Test: `server/test/knowledge-generation-run.test.ts`

**Interfaces:**
- Consumes: `KbGenerationClassification` from Task 1.
- Produces: `GenerationExtractionResult.classification`, `.classificationReason`, `.proposals`.
- Produces: deterministic `hasBothConversationSides(messages): boolean` used before a paid call.
- [ ] **Step 1: Add failing classification cases**

```ts
it.each(['friend', 'self', 'staff', 'supplier', 'unrelated_business'])('%s produces no proposals', async (fixture) => {
  const result = await extractGenerationBatch(depsFor(fixture), messagesFor(fixture));
  expect(result.classification).not.toBe('customer');
  expect(result.proposals).toEqual([]);
});

it('does not call the provider without both customer and seller messages', async () => {
  const model = vi.fn();
  await expect(extractGenerationBatch(deps(model), sellerOnlyMessages())).resolves.toMatchObject({ proposals: [] });
  expect(model).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and verify the new cases fail**

Run: `npm --prefix server test -- knowledge-generation-extract.test.ts knowledge-generation-run.test.ts`
Expected: FAIL because extraction has no classification and seller-only input can reach the old path.

- [ ] **Step 3: Require classified JSON and enforce evidence**

```ts
const outputSchema = z.object({
  classification: z.object({
    value: z.enum(['customer', 'irrelevant', 'uncertain']),
    reason: z.string().trim().min(1).max(240),
  }),
  proposals: z.array(proposalSchema).max(GENERATION_LIMITS.maxProposalsPerBatch),
});
```

Update the prompt with explicit customer/irrelevant examples and bans on profanity, personal names, addresses, phone numbers, internal commands, and one-off promises. Coerce unsupported or ungrounded `customer` classifications to `uncertain`; accept proposals only for verified `customer` batches.

- [ ] **Step 4: Persist classification and exclusion metrics per completed batch**

```ts
await tx.update(kbGenerationBatches).set({
  status: 'done',
  classification: result.classification,
  classificationReason: result.classificationReason,
  updatedAt: new Date(),
}).where(eq(kbGenerationBatches.id, batch.id));
```

- [ ] **Step 5: Run focused server tests**

Run: `npm --prefix server test -- knowledge-generation-extract.test.ts knowledge-generation-run.test.ts knowledge-generation-api.test.ts`
Expected: PASS, including zero provider calls for one-sided batches.

- [ ] **Step 6: Commit Task 2 files**

```bash
git add server/src/lib/knowledge/generation-extract.ts server/src/lib/knowledge/generation-types.ts server/src/lib/knowledge/generation-run.ts server/test/knowledge-generation-extract.test.ts server/test/knowledge-generation-run.test.ts
git commit -m "feat: exclude unrelated WhatsApp conversations"
```

### Task 3: Consolidate grounded findings into concise review items

**Files:**
- Create: `server/src/lib/knowledge/generation-consolidate.ts`
- Modify: `server/src/lib/knowledge/generation-run.ts`
- Modify: `server/src/lib/knowledge/generation-limits.ts`
- Test: `server/test/knowledge-generation-consolidate.test.ts`
- Test: `server/test/knowledge-generation-run.test.ts`

**Interfaces:**
- Consumes: accepted raw proposals and saved `CommunicationStyle`.
- Produces: `consolidateGenerationProposals(deps, input): Promise<ConsolidationResult>` with verified raw proposal IDs.
- Produces: final proposal `kind`, `confidence`, `selected`, merged sources, and recorded usage.
- [ ] **Step 1: Write failing consolidation tests**

```ts
expect(await consolidateGenerationProposals(deps, duplicateDeliveryFacts())).toEqual({
  items: [expect.objectContaining({ kind: 'knowledge', sourceProposalIds: ['p1', 'p2'] })],
  usage: expect.any(Object),
});
expect((await consolidateGenerationProposals(deps, outputWithUnknownSource())).items).toEqual([]);
expect(JSON.stringify(await consolidateGenerationProposals(deps, unsafeOutput()))).not.toMatch(/address|phone|ругательство/i);
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm --prefix server test -- knowledge-generation-consolidate.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic deduplication and bounded model consolidation**

```ts
export interface ConsolidatedProposal {
  kind: 'knowledge' | 'script';
  path: string;
  body: string;
  confidence: 'high' | 'review';
  sourceProposalIds: string[];
}
```

Group by kind, remove exact fingerprints locally, split calls by configured item/character limits, and reject every result whose cited raw proposal IDs are not present. Map accepted IDs back to immutable message sources and run the existing redactor over path/body.

- [ ] **Step 4: Apply the saved style only to script consolidation**

```ts
const styleInstruction = communicationStyleInstruction(input.communicationStyle);
// Knowledge facts stay neutral; script phrases receive styleInstruction.
```

Default-select only high-confidence, warning-free final proposals. Keep raw findings available through detail API data but do not render them as the primary list.

- [ ] **Step 5: Run consolidation and orchestration tests**

Run: `npm --prefix server test -- knowledge-generation-consolidate.test.ts knowledge-generation-run.test.ts knowledge-generation-review.test.ts`
Expected: PASS with merged sources and no unsupported output.

- [ ] **Step 6: Commit Task 3 files**

```bash
git add server/src/lib/knowledge/generation-consolidate.ts server/src/lib/knowledge/generation-run.ts server/src/lib/knowledge/generation-limits.ts server/test/knowledge-generation-consolidate.test.ts server/test/knowledge-generation-run.test.ts
git commit -m "feat: consolidate WhatsApp knowledge proposals"
```

### Task 4: Expose persistent run, selection, draft, and style APIs

**Files:**
- Modify: `server/src/lib/knowledge/generation-review.ts`
- Modify: `server/src/api/knowledge-generation.ts`
- Modify: `server/src/api/agents.ts`
- Modify: `server/src/api/server.ts`
- Modify: `rakurs/src/api/index.ts`
- Test: `server/test/knowledge-generation-api.test.ts`
- Test: `server/test/knowledge-generation-review.test.ts`
- Test: `server/test/agent-style-api.test.ts`

**Interfaces:**
- Produces: `PATCH /knowledge/generation/proposals/:proposalId` supporting `selected` with `revision`.
- Produces: paginated run detail with `drafts`, `exclusions`, `rawFindings`, counts, usage, and errors.
- Produces: `GET/PATCH /agents/:agentId/communication-style`.
- Produces: draft creation from persisted selected proposals only.
- [ ] **Step 1: Write failing API tests**

```ts
expect((await app.inject({ method: 'GET', url: runsUrl })).json().nextCursor).toBeTruthy();
expect(detail.json().drafts).toContainEqual(expect.objectContaining({ id: draftId }));
expect(staleSelection.statusCode).toBe(409);
expect(stylePatch.json()).toMatchObject({ preset: 'friendly', preview: expect.any(String) });
```

- [ ] **Step 2: Run focused API tests and verify failures**

Run: `npm --prefix server test -- knowledge-generation-api.test.ts knowledge-generation-review.test.ts agent-style-api.test.ts`
Expected: FAIL on selection persistence, run-draft history, and style routes.

- [ ] **Step 3: Extend revision-safe proposal updates and transactional draft creation**

```ts
const proposalUpdateBody = z.object({
  revision: z.number().int().positive(),
  path: z.string().optional(),
  body: z.string().optional(),
  selected: z.boolean().optional(),
  status: z.enum(['pending', 'rejected']).optional(),
});
```

Draft creation locks the run and selected proposals, verifies revisions and tenant ownership, inserts one draft plus `kb_generation_drafts`, and updates proposal status in the same transaction. It never writes `kb_notes` or `agent_rules`.

- [ ] **Step 4: Return complete paginated history and auditable detail**

Include classification counts, exclusion reason summaries, proposal kind/confidence/selection, every related draft, and optional raw findings. Historical rows with null classification render as `uncertain` with reason `Earlier run`.

- [ ] **Step 5: Add style read/update endpoints**

Validate only `warm`, `calm`, and `friendly`; owner may update, members may read. Return a deterministic Russian preview and preserve `configVersion` because style changes future replies.

- [ ] **Step 6: Run API tests**

Run: `npm --prefix server test -- knowledge-generation-api.test.ts knowledge-generation-review.test.ts agent-style-api.test.ts rules-api.test.ts knowledge-api.test.ts`
Expected: PASS and no notes/rules created by generation tests.

- [ ] **Step 7: Commit Task 4 files**

```bash
git add server/src/lib/knowledge/generation-review.ts server/src/api/knowledge-generation.ts server/src/api/agents.ts server/src/api/server.ts rakurs/src/api/index.ts server/test/knowledge-generation-api.test.ts server/test/knowledge-generation-review.test.ts server/test/agent-style-api.test.ts
git commit -m "feat: add knowledge review workspace APIs"
```

### Task 5: Apply communication style to future live replies

**Files:**
- Create: `server/src/lib/ai/communication-style.ts`
- Modify: `server/src/lib/ai/prompt.ts`
- Modify: `server/src/lib/ai/turn.ts`
- Test: `server/test/communication-style.test.ts`
- Test: `server/test/ai-prompt.test.ts`
- Test: `server/test/ai-turn.test.ts`

**Interfaces:**
- Consumes: `agents.communicationStyle`.
- Produces: `communicationStyleInstruction(style)` shared with generation consolidation.
- Preserves: existing reply JSON schema, knowledge grounding, language selection, handoff, and safety guards.
- [ ] **Step 1: Write failing style prompt tests**

```ts
expect(communicationStyleInstruction('warm')).toContain('0–2');
expect(buildMessages(contextWithStyle('warm'))[0].content).toContain('коротко и естественно');
expect(buildMessages(contextWithStyle('calm'))[0].content).not.toContain('обязательно используй эмодзи');
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm --prefix server test -- communication-style.test.ts ai-prompt.test.ts ai-turn.test.ts`
Expected: FAIL because style is not gathered or rendered.

- [ ] **Step 3: Implement style instructions and gather the field in `runTurn`**

```ts
export const COMMUNICATION_STYLE: Record<CommunicationStyle, string> = {
  warm: 'Пиши живо и тепло, уважительно на вы/сіз, короткими фразами; используй 0–2 уместных эмодзи.',
  calm: 'Пиши спокойно, ясно и уважительно, без канцелярита и без лишних эмодзи.',
  friendly: 'Пиши дружелюбно и естественно, коротко, без фамильярности и шаблонных фраз.',
};
```

Insert the style instruction after the immutable safety rules and before owner instructions. Keep the existing Russian/Kazakh language behavior authoritative.

- [ ] **Step 4: Run AI regression tests**

Run: `npm --prefix server test -- communication-style.test.ts ai-prompt.test.ts ai-turn.test.ts turn-cap.test.ts`
Expected: PASS with unchanged validation and send behavior.

- [ ] **Step 5: Commit Task 5 files**

```bash
git add server/src/lib/ai/communication-style.ts server/src/lib/ai/prompt.ts server/src/lib/ai/turn.ts server/test/communication-style.test.ts server/test/ai-prompt.test.ts server/test/ai-turn.test.ts
git commit -m "feat: apply natural agent communication styles"
```

### Task 6: Build the wide three-column review workspace

**Files:**
- Create: `rakurs/src/components/knowledge/KnowledgeWorkspace.tsx`
- Create: `rakurs/src/components/knowledge/GenerationRunRail.tsx`
- Create: `rakurs/src/components/knowledge/ProposalWorkspace.tsx`
- Create: `rakurs/src/components/knowledge/CommunicationStyleCard.tsx`
- Create: `rakurs/src/screens/knowledge-workspace.css`
- Modify: `rakurs/src/screens/KnowledgeScreen.tsx`
- Modify: `rakurs/src/components/knowledge/GenerationReview.tsx`
- Modify: `rakurs/src/components/knowledge/ChatGenerationPanel.tsx`
- Test: `rakurs/src/components/knowledge/KnowledgeWorkspace.test.tsx`
- Test: `rakurs/src/components/knowledge/ProposalWorkspace.test.tsx`
- Test: `rakurs/src/components/knowledge/CommunicationStyleCard.test.tsx`

**Interfaces:**
- Consumes: Task 4 run/detail/proposal/style client methods.
- Produces: tabs `Знания`, `Черновики`, `Запуски`, `Источники и загрузка` and layout A.
- Preserves: `?generation=<runId>` deep link and draft/note navigation.
- [ ] **Step 1: Write failing workspace behavior tests**

```tsx
expect(screen.getByRole('tab', { name: 'Черновики' })).toBeVisible();
expect(screen.getByRole('button', { name: /Показать ещё запусков/ })).toBeVisible();
await user.click(screen.getByRole('checkbox', { name: /Добавить/ }));
expect(api.updateKnowledgeGenerationProposal).toHaveBeenCalledWith(agentId, proposalId, expect.objectContaining({ selected: true }));
```

- [ ] **Step 2: Run frontend tests and verify failure**

Run: `npm --prefix rakurs test -- KnowledgeWorkspace.test.tsx ProposalWorkspace.test.tsx CommunicationStyleCard.test.tsx`
Expected: FAIL because the workspace components do not exist.

- [ ] **Step 3: Implement route tabs and layout A**

```css
.knowledge-workspace {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(480px, 1fr) minmax(240px, 320px);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1050px) { .knowledge-workspace { grid-template-columns: 220px minmax(0, 1fr); } }
@media (max-width: 720px) { .knowledge-workspace { display: block; } }
```

The left rail paginates every run, the center switches `База знаний`/`Скрипт продаж`, and the right side shows style plus every draft link for the selected run. Keep controls compact and avoid nested full-width cards.

- [ ] **Step 4: Persist selection and support inline editing/rejection**

Use server `selected` as the source of truth, optimistic local feedback with rollback on error, revision-aware path/body saves, select-all for visible eligible items, clear selection, and `Собрать новый черновик` using the persisted checked set.

- [ ] **Step 5: Render sources, warnings, exclusions, and raw audit data**

Each proposal shows source count and links. Excluded batches show classification reason without editable proposal controls. Raw findings stay collapsed under `Исходные находки`.

- [ ] **Step 6: Run workspace and existing generation tests**

Run: `npm --prefix rakurs test -- KnowledgeWorkspace.test.tsx ProposalWorkspace.test.tsx CommunicationStyleCard.test.tsx GenerationDraftLinks.test.ts RecentHistoryPreparation.test.ts generation-state.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit Task 6 files**

```bash
git add rakurs/src/components/knowledge/KnowledgeWorkspace.tsx rakurs/src/components/knowledge/GenerationRunRail.tsx rakurs/src/components/knowledge/ProposalWorkspace.tsx rakurs/src/components/knowledge/CommunicationStyleCard.tsx rakurs/src/screens/knowledge-workspace.css rakurs/src/screens/KnowledgeScreen.tsx rakurs/src/components/knowledge/GenerationReview.tsx rakurs/src/components/knowledge/ChatGenerationPanel.tsx rakurs/src/components/knowledge/KnowledgeWorkspace.test.tsx rakurs/src/components/knowledge/ProposalWorkspace.test.tsx rakurs/src/components/knowledge/CommunicationStyleCard.test.tsx
git commit -m "feat: redesign the knowledge review workspace"
```

### Task 7: Move imports into compact source cards

**Files:**
- Create: `rakurs/src/components/knowledge/KnowledgeSourceCards.tsx`
- Modify: `rakurs/src/screens/KnowledgeScreen.tsx`
- Modify: `rakurs/src/components/knowledge/HistoryImportPanel.tsx`
- Modify: `rakurs/src/components/knowledge/ImportPanel.tsx`
- Test: `rakurs/src/components/knowledge/KnowledgeSourceCards.test.tsx`
- Test: `rakurs/src/components/knowledge/layout.test.ts`

**Interfaces:**
- Consumes: current WhatsApp history/import APIs unchanged.
- Produces: one expanded source card at a time for WhatsApp, Instagram, pasted text, and web page.
- [ ] **Step 1: Write failing compact-source tests**

```tsx
expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
await user.click(screen.getByRole('button', { name: 'WhatsApp' }));
expect(screen.getByRole('button', { name: /Загрузить историю/ })).toBeVisible();
expect(screen.queryByLabelText('Вставить текст')).not.toBeVisible();
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm --prefix rakurs test -- KnowledgeSourceCards.test.tsx layout.test.ts`
Expected: FAIL because all upload blocks are still stacked.

- [ ] **Step 3: Implement the single-expanded-card interaction**

Render connection/archive status in the collapsed WhatsApp header, retain the last-two-weeks shortcut, and mount existing import panels only inside the active card. Instagram uses the existing setup/link flow and displays actionable OAuth errors without inventing permissions.

- [ ] **Step 4: Run source and history regressions**

Run: `npm --prefix rakurs test -- KnowledgeSourceCards.test.tsx HistoryImportPanel.test.ts RecentHistoryPreparation.test.ts layout.test.ts`
Expected: PASS and only one import panel visible at a time.

- [ ] **Step 5: Commit Task 7 files**

```bash
git add rakurs/src/components/knowledge/KnowledgeSourceCards.tsx rakurs/src/screens/KnowledgeScreen.tsx rakurs/src/components/knowledge/HistoryImportPanel.tsx rakurs/src/components/knowledge/ImportPanel.tsx rakurs/src/components/knowledge/KnowledgeSourceCards.test.tsx rakurs/src/components/knowledge/layout.test.ts
git commit -m "feat: compact knowledge source imports"
```

### Task 8: Verify, deploy, and run a real two-week generation

**Files:**
- Modify: `docs/whatsapp-knowledge-release-qa.md`
- Modify only if required by deployment: `deploy/compose.yml`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: production deployment, filtered two-week run, two review drafts, and recorded verification evidence.
- [ ] **Step 1: Run clean focused suites and record existing unrelated failures separately**

Run: `npm --prefix server test -- knowledge-generation-workspace-schema.test.ts knowledge-generation-extract.test.ts knowledge-generation-consolidate.test.ts knowledge-generation-run.test.ts knowledge-generation-review.test.ts knowledge-generation-api.test.ts agent-style-api.test.ts communication-style.test.ts`

Run: `npm --prefix rakurs test -- KnowledgeWorkspace.test.tsx ProposalWorkspace.test.tsx CommunicationStyleCard.test.tsx KnowledgeSourceCards.test.tsx HistoryImportPanel.test.ts`

Expected: PASS. Any pre-existing Kaspi typecheck failure is reported separately and is not hidden.

- [ ] **Step 2: Build production artifacts**

Run: `npm run build`
Expected: server and frontend builds succeed. If unrelated dirty-tree work prevents a monolithic build, isolate and document the exact blocker before deploying only reviewed artifacts.

- [ ] **Step 3: Deploy the additive migration and application images**

Create rollback image tags before updating services. Apply migration `0029_knowledge_review_workspace.sql`, deploy API and frontend, and wait for health checks before proceeding.

- [ ] **Step 4: Perform human-style production browser QA**

Verify desktop and narrow viewport behavior, all four tabs, complete paginated run history, run/draft deep links, inline edit, persisted checkbox selection, rejection, style save/preview, and compact source cards. Confirm no console errors or failed API requests.

- [ ] **Step 5: Run the latest-two-weeks WhatsApp generation**

Use the existing real archive selection for the last 14 days. Confirm non-customer exclusions, inspect knowledge and script output for personal data/internal language, create review drafts only from checked items, and leave both drafts unpublished.

- [ ] **Step 6: Prove no automatic publication occurred**

Record note and rule counts before and after generation/draft creation; both counts must remain unchanged. Record run ID, relevant/excluded counts, proposal counts, token usage, cost, and draft IDs in the QA document without storing secrets or message bodies.

- [ ] **Step 7: Commit QA evidence**

```bash
git add docs/whatsapp-knowledge-release-qa.md
git commit -m "docs: verify filtered WhatsApp knowledge generation"
```
