# Training Workspace Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Started on: Opus 5 · Subtasks: Opus 5 (session model governs every subagent)

**Goal:** Replace the «База знаний» and «Обучение» sections with one intent-organised
«Обучение агента» section.

**Architecture:** Frontend only (`rakurs/src`). Pure routing and state-derivation modules
drive a thin tab shell; existing knowledge, generation and coach components are reused
and split, not rewritten. Old URLs redirect.

**Tech Stack:** React 18, react-router-dom 6, Vite, Vitest 4 (`renderToStaticMarkup` for
render tests, jsdom + @testing-library for interaction), plain CSS with tokens.

**Spec:** `docs/superpowers/specs/2026-09-13-training-workspace-merge-design.md`

**Prerequisite:** Phase 0 is done — `codex/semantic-release-fixed` is merged into this
branch. The file paths below are the post-merge paths.

## Global Constraints

- No server, contract or API change. No new npm dependency.
- UI strings are Russian and hardcoded. Code, comments, test names and commits are English.
- Owner-only endpoints (`listRules`, coach routes, `listOpenDrafts`, generation runs) are
  never called for a non-owner.
- No feature is removed; it moves or folds under a collapsed «Подробности».
- Every `.md` file stays under 500 lines.
- Run tests with `npm test --workspace rakurs -- <file>`; typecheck with
  `npm run typecheck --workspace rakurs`. Use `npm install --cache "$TMPDIR/npm-cache"` if
  install is needed.

## Batching

Per the user's standing preference: tasks 1–2 go in one dispatch, 3–4 in one, 5–6 in one,
7 alone. One review at the end, plus a browser check.

## File map

| File | Responsibility |
|---|---|
| `lib/training-routes.ts` (new) | Tab and teach-mode parsing, URL building, legacy URL mapping |
| `lib/training-state.ts` (new) | `wizardStep`, `nextStep`, `draftOrigin`, `tabAfterKey` |
| `screens/TrainingScreen.tsx` (new) | Tab shell, default tab, visibility, strip |
| `components/training/KnowledgeTab.tsx` (new) | Notes tab body, moved out of `KnowledgeScreen` |
| `components/training/RepliesTab.tsx` (new) | Style card + rules |
| `components/training/TeachTab.tsx` (new) | Chooser and the three modes |
| `components/training/GenerationWizard.tsx` (new) | Replaces `ChatGenerationPanel`'s render |
| `components/training/ReviewList.tsx` (new) | Open drafts list |
| `components/training/NextStepStrip.tsx` (new) | The strip |
| `components/coach/CoachChat.tsx` (new) | Conversation column, moved out of `CoachScreen` |
| `screens/training-workspace.css` (renamed from `knowledge-workspace.css`) | Styles |
| Deleted | `screens/KnowledgeScreen.tsx`, `screens/CoachScreen.tsx`, `components/knowledge/KnowledgeWorkspace.tsx` |

Paths are relative to `rakurs/src`.

---

### Task 1: Routing module

**Files:**
- Create: `rakurs/src/lib/training-routes.ts`
- Test: `rakurs/src/lib/training-routes.test.ts`

**Interfaces — Produces:**
```ts
export type TrainingTab = 'knowledge' | 'replies' | 'teach' | 'review';
export type TeachMode = 'chats' | 'coach' | 'import';
export const TRAINING_TABS: ReadonlyArray<{ id: TrainingTab; label: string; ownerOnly: boolean }>;
export const CORRECTION_PARAMS: readonly ['conversation', 'reply', 'session', 'turn', 'message'];
export function visibleTabs(owner: boolean): TrainingTab[];
export function trainingTabFromSearch(params: URLSearchParams, ctx: { owner: boolean; noteCount: number | null }): TrainingTab;
export function teachModeFromSearch(params: URLSearchParams): TeachMode | null;
export function trainingSearch(current: URLSearchParams, tab: TrainingTab, teach?: TeachMode | null): URLSearchParams;
export function withoutCorrectionParams(current: URLSearchParams): URLSearchParams;
export function legacyKnowledgeSearch(current: URLSearchParams): URLSearchParams;
export function legacyCoachSearch(current: URLSearchParams): URLSearchParams;
```

Rules:
- `TRAINING_TABS` labels: `knowledge` «Знания», `replies` «Как отвечает», `teach` «Научить»,
  `review` «На проверке»; `ownerOnly` is true for `teach` and `review`.
- `trainingTabFromSearch`:
  1. A valid `tab` that is visible for `owner` wins.
  2. Owner with `generation` or any correction param → `teach`.
  3. Owner with `noteCount === 0` → `teach`.
  4. Otherwise → `knowledge`. `noteCount === null` means unknown; treat as not empty.
- `teachModeFromSearch`: a valid `teach` wins; else `generation` → `chats`; else any
  correction param → `coach`; else `null`.
- `trainingSearch` copies params, sets `tab`, sets `teach` when a mode is given, and deletes
  `teach` when the mode is `null` or the tab is not `teach`. Leaving `teach` also deletes
  `generation` and the correction params. Leaving `knowledge` deletes `note`.
- `legacyKnowledgeSearch`: `tab=drafts|runs` → `tab=teach&teach=chats`;
  `tab=sources` → `tab=teach&teach=import`; any other value or none → `tab=knowledge`,
  except that `generation` without `tab` → `teach&teach=chats`. Everything else is kept.
- `legacyCoachSearch`: sets `tab=teach&teach=coach` and keeps every other param.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { legacyCoachSearch, legacyKnowledgeSearch, teachModeFromSearch, trainingSearch,
  trainingTabFromSearch, visibleTabs, withoutCorrectionParams } from './training-routes';

const p = (s: string) => new URLSearchParams(s);
const owner = { owner: true, noteCount: 5 };

describe('training routes', () => {
  it('shows four tabs to the owner and two to others', () => {
    expect(visibleTabs(true)).toEqual(['knowledge', 'replies', 'teach', 'review']);
    expect(visibleTabs(false)).toEqual(['knowledge', 'replies']);
  });
  it('honours a valid tab and ignores tabs a non-owner cannot see', () => {
    expect(trainingTabFromSearch(p('tab=review'), owner)).toBe('review');
    expect(trainingTabFromSearch(p('tab=review'), { owner: false, noteCount: 5 })).toBe('knowledge');
    expect(trainingTabFromSearch(p('tab=nope'), owner)).toBe('knowledge');
  });
  it('opens teach for deep links and for an empty base', () => {
    expect(trainingTabFromSearch(p('generation=r1'), owner)).toBe('teach');
    expect(trainingTabFromSearch(p('conversation=c1&reply=a1'), owner)).toBe('teach');
    expect(trainingTabFromSearch(p(''), { owner: true, noteCount: 0 })).toBe('teach');
    expect(trainingTabFromSearch(p(''), { owner: true, noteCount: null })).toBe('knowledge');
    expect(trainingTabFromSearch(p(''), { owner: false, noteCount: 0 })).toBe('knowledge');
  });
  it('derives the teach mode', () => {
    expect(teachModeFromSearch(p('teach=import&generation=r1'))).toBe('import');
    expect(teachModeFromSearch(p('generation=r1'))).toBe('chats');
    expect(teachModeFromSearch(p('session=s1&turn=t1'))).toBe('coach');
    expect(teachModeFromSearch(p('teach=bad'))).toBeNull();
  });
  it('builds tab URLs and drops state that belongs to the tab being left', () => {
    expect(trainingSearch(p('tab=teach&teach=chats&generation=r1'), 'review').toString()).toBe('tab=review');
    expect(trainingSearch(p('tab=knowledge&note=n1'), 'teach', 'coach').toString()).toBe('tab=teach&teach=coach');
    expect(trainingSearch(p('tab=teach&teach=chats'), 'teach', null).toString()).toBe('tab=teach');
  });
  it('removes only correction params', () => {
    expect(withoutCorrectionParams(p('tab=teach&teach=coach&conversation=c&reply=r&message=m')).toString())
      .toBe('tab=teach&teach=coach');
  });
  it('maps legacy knowledge URLs', () => {
    expect(legacyKnowledgeSearch(p('')).toString()).toBe('tab=knowledge');
    expect(legacyKnowledgeSearch(p('note=n1')).toString()).toBe('note=n1&tab=knowledge');
    expect(legacyKnowledgeSearch(p('tab=runs&generation=r1')).toString()).toBe('tab=teach&generation=r1&teach=chats');
    expect(legacyKnowledgeSearch(p('generation=r1')).toString()).toBe('generation=r1&tab=teach&teach=chats');
    expect(legacyKnowledgeSearch(p('tab=sources')).toString()).toBe('tab=teach&teach=import');
  });
  it('maps legacy coach URLs and keeps correction params', () => {
    expect(legacyCoachSearch(p('conversation=c1&reply=a1')).toString())
      .toBe('conversation=c1&reply=a1&tab=teach&teach=coach');
  });
});
```

- [ ] **Step 2: Run** `npm test --workspace rakurs -- src/lib/training-routes.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `training-routes.ts` per the rules above. `URLSearchParams.set` keeps an existing key's position, so tests pin the order.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(training): add training workspace routing`.

### Task 2: State derivation module

**Files:**
- Create: `rakurs/src/lib/training-state.ts`
- Test: `rakurs/src/lib/training-state.test.ts`
- Modify: `components/knowledge/ProposalWorkspace.tsx` to import `tabAfterKey` from `@/lib/training-state`.

**Interfaces — Produces:**
```ts
export type WizardStep = 'period' | 'processing' | 'selection' | 'draft';
export function wizardStep(detail: { run: { status: KbGenerationRunDetail['run']['status']; proposalCount: number }; drafts: { id: string }[] } | null, pickMore: boolean): WizardStep;
export type NextStep = { kind: 'running'; percent: number; runId: string } | { kind: 'review'; count: number } | { kind: 'empty' } | null;
export function nextStep(input: { owner: boolean; activeRun: { id: string; completedBatchCount: number; batchCount: number } | null; openDrafts: number; noteCount: number | null }): NextStep;
export type DraftOriginLabel = 'Тренер' | 'Из переписки' | 'Вручную';
export function draftOrigin(draft: Pick<KbDraft, 'origin' | 'title'>): DraftOriginLabel;
export function tabAfterKey<T extends string>(ids: readonly T[], current: T, key: string): T | null; // moved verbatim from KnowledgeWorkspace.tsx
```

Rules:
- `wizardStep`: `null` → `period`. `queued`/`running` → `processing`. `failed` or `cancelled`
  with `proposalCount === 0` → `processing`. Otherwise, if `drafts.length > 0 && !pickMore`
  → `draft`, else `selection`. A completed run with zero proposals is `selection` (its empty
  state says nothing was found).
- `nextStep`: non-owner → `null`. Active run → `running` with
  `percent = batchCount > 0 ? Math.floor(completedBatchCount * 100 / batchCount) : 0`.
  Else `openDrafts > 0` → `review`. Else `noteCount === 0` → `empty`. Else `null`.
- `draftOrigin`: `origin === 'coach'` → «Тренер»; a title ending in « из WhatsApp» (the
  server's `draftKinds` titles in `server/src/lib/knowledge/generation-review.ts`) →
  «Из переписки»; otherwise «Вручную».

- [ ] **Step 1: Write the failing tests** — one `it` per rule above:

```ts
import { describe, expect, it } from 'vitest';
import { draftOrigin, nextStep, wizardStep } from './training-state';

const run = (status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled', proposalCount = 3, drafts = 0) =>
  ({ run: { status, proposalCount }, drafts: Array.from({ length: drafts }, (_, i) => ({ id: `d${i}` })) });

describe('wizardStep', () => {
  it('starts at the period step without a run', () => expect(wizardStep(null, false)).toBe('period'));
  it('stays on processing while active or failed empty', () => {
    expect(wizardStep(run('running'), false)).toBe('processing');
    expect(wizardStep(run('queued'), false)).toBe('processing');
    expect(wizardStep(run('failed', 0), false)).toBe('processing');
    expect(wizardStep(run('cancelled', 0), false)).toBe('processing');
  });
  it('moves to selection, then draft, and back on request', () => {
    expect(wizardStep(run('completed'), false)).toBe('selection');
    expect(wizardStep(run('completed', 0), false)).toBe('selection');
    expect(wizardStep(run('failed', 2), false)).toBe('selection');
    expect(wizardStep(run('completed', 3, 1), false)).toBe('draft');
    expect(wizardStep(run('completed', 3, 1), true)).toBe('selection');
  });
});

describe('nextStep', () => {
  const base = { owner: true, activeRun: null, openDrafts: 0, noteCount: 4 };
  it('says nothing to non-owners or when all is done', () => {
    expect(nextStep({ ...base, owner: false, openDrafts: 3 })).toBeNull();
    expect(nextStep(base)).toBeNull();
  });
  it('ranks an active run over drafts over an empty base', () => {
    const activeRun = { id: 'r1', completedBatchCount: 1, batchCount: 3 };
    expect(nextStep({ ...base, activeRun, openDrafts: 2, noteCount: 0 })).toEqual({ kind: 'running', percent: 33, runId: 'r1' });
    expect(nextStep({ ...base, openDrafts: 2, noteCount: 0 })).toEqual({ kind: 'review', count: 2 });
    expect(nextStep({ ...base, noteCount: 0 })).toEqual({ kind: 'empty' });
    expect(nextStep({ ...base, activeRun: { id: 'r2', completedBatchCount: 0, batchCount: 0 } })).toEqual({ kind: 'running', percent: 0, runId: 'r2' });
  });
});

describe('draftOrigin', () => {
  it('labels drafts by where they came from', () => {
    expect(draftOrigin({ origin: 'coach', title: 'Правило' })).toBe('Тренер');
    expect(draftOrigin({ origin: 'manual', title: 'Скрипт продаж из WhatsApp' })).toBe('Из переписки');
    expect(draftOrigin({ origin: 'manual', title: 'Правка цен' })).toBe('Вручную');
  });
});
```

- [ ] **Step 2: Run** `npm test --workspace rakurs -- src/lib/training-state.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Move `tabAfterKey` and its test cases from `KnowledgeWorkspace.test.tsx` into `training-state.test.ts`; update the import in `ProposalWorkspace.tsx`.
- [ ] **Step 4: Run** both test files plus `ProposalWorkspace.test.tsx` — expect PASS.
- [ ] **Step 5: Commit** `feat(training): derive wizard step, next step and draft origin`.

### Task 3: Tab shell, section, routes and links

**Files:**
- Create: `screens/TrainingScreen.tsx`, `components/training/KnowledgeTab.tsx`,
  `screens/TrainingScreen.test.tsx`
- Modify: `lib/sections.ts`, `App.tsx`, `components/setup/guides.tsx` (links at the
  «База знаний» and «Обучение» mentions), `screens/AgentScreen.tsx:~413`,
  `screens/DialogsScreen.tsx:~74` and `:~107`, `screens/DraftScreen.tsx` (both
  `navigate('../coach')`), `components/knowledge/KnowledgeSourceCards.tsx`
  (`recentHistorySearch`), plus any other hit of
  `git grep -n "\.\./knowledge\|\.\./coach\|/knowledge\`\|/coach\`" rakurs/src`
- Rename: `screens/knowledge-workspace.css` → `screens/training-workspace.css`
  (rename `.knowledge-page*` and `.knowledge-tabs` selectors to `.training-page*` and
  `.training-tabs`; leave the other selectors alone)
- Delete: `screens/KnowledgeScreen.tsx`, `components/knowledge/KnowledgeWorkspace.tsx`
  and its test (keep the `GenerationRunRail` cases by moving them into
  `GenerationRunRail.test.tsx`)

**Interfaces — Consumes:** Task 1 and Task 2 exports.
**Produces:**
```ts
export function TrainingScreen(): JSX.Element;
export function TrainingWorkspace(props: { tabs: TrainingTab[]; activeTab: TrainingTab; reviewCount: number | null; strip: ReactNode; onTabChange: (tab: TrainingTab) => void; children: ReactNode }): JSX.Element;
export function KnowledgeTab(props: { onDirtyChange: (dirty: boolean) => void; onTeach: () => void }): JSX.Element;
```

Steps:
- [ ] **Step 1: Write render tests** in `TrainingScreen.test.tsx` against
  `TrainingWorkspace` (pure props, `renderToStaticMarkup`):
  - `tabs=visibleTabs(true)` renders four `role="tab"` elements with labels «Знания»,
    «Как отвечает», «Научить», «На проверке (3)» when `reviewCount=3`, and the active tab
    has `aria-selected="true"`.
  - `tabs=visibleTabs(false)` renders exactly two tabs and no «Научить».
  - the heading is «Обучение агента»; the `strip` node is rendered above the tablist.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - `sections.ts`: replace the two entries with
    `{ path: 'training', label: 'Обучение агента', pending: '' }` at the same position.
  - `App.tsx`: `section.path === 'training' ? <TrainingScreen />`. Add
    `<Route path="knowledge" element={<LegacyTrainingRedirect map={legacyKnowledgeSearch} />} />`
    and the same for `coach` with `legacyCoachSearch`, next to `LegacyDialogsRedirect`,
    implemented as `<Navigate to={`../training?${map(new URLSearchParams(location.search))}`} replace />`.
  - `TrainingWorkspace`: markup of the old `KnowledgeWorkspace` (tablist with arrow-key
    handling via `tabAfterKey`, `role="tabpanel"`), header kicker removed, title
    «Обучение агента», subtitle «Чему агент научен, как он отвечает и что ждёт вашего
    решения.», then `strip`, then tabs.
  - `KnowledgeTab`: body of the old `KnowledgeScreen`'s `activeTab === 'knowledge'` branch,
    with its hooks. Tab-level subtitle from the spec above the layout. The tree groups notes
    whose path starts with `Скрипт/` under a top-level node labelled «Скрипт продаж»
    (do it in `buildTree`'s caller by rewriting the display label only; do not change
    paths). Owner empty state: text «База знаний пуста. Агенту пока нечем отвечать.» with
    buttons «Научить из переписки» (`onTeach`) and «Создать заметку».
  - `TrainingScreen`: reads `useAgent()`, loads `noteCount` via
    `api.listKbNotes(agent.id, {})` (length; `null` while loading), owner-only
    `api.listOpenDrafts` and the first page of `api.listKnowledgeGenerationRuns`. Computes
    the tab with `trainingTabFromSearch`; changes tabs with `trainingSearch`, asking
    `window.confirm('Уйти без сохранения? Несохранённые правки будут потеряны.')` when
    leaving a dirty `KnowledgeTab`. Tabs other than `knowledge` render a temporary
    `<EmptyState>` until Tasks 4–6 replace them.
  - Update every link listed under Files to `../training?tab=…` (Dialogs «Так нельзя»:
    `../training?tab=teach&teach=coach&conversation=…`; DraftScreen after apply/discard:
    `../training?tab=review`; guides: `../training?tab=knowledge` and
    `../training?tab=teach&teach=coach`; `recentHistorySearch` sets
    `tab=teach&teach=chats` and deletes `generation`). Update their existing tests.
- [ ] **Step 4: Run** the full rakurs suite and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(training): merge knowledge and coaching into one section`.

### Task 4: «Как отвечает» and the coach chat

**Files:**
- Create: `components/training/RepliesTab.tsx`, `components/coach/CoachChat.tsx`
- Move tests: `screens/CoachScreen.test.ts` → `components/coach/CoachChat.test.ts`;
  `screens/CoachScreen.interaction.test.tsx` → `components/coach/CoachChat.interaction.test.tsx`
- Delete: `screens/CoachScreen.tsx`
- Modify: `screens/TrainingScreen.tsx`

**Produces:**
```ts
export function RepliesTab(props: { agentId: string; owner: boolean; onOpenCoach: () => void }): JSX.Element;
export function CoachChat(props: { agentId: string; onOpenRules: () => void }): JSX.Element;
```

- [ ] **Step 1: Move the coach tests** and change their render target to `CoachChat`. Add
  an interaction test: with URL
  `?tab=teach&teach=coach&conversation=c1&reply=a1`, after a completed correction the URL
  keeps `tab=teach&teach=coach` and loses `conversation` and `reply`. Add a render test for
  `RepliesTab` with `owner=false`: contains «Стиль общения», does not contain «Правила»,
  and the mocked `api.listRules` is never called.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - `CoachChat` = old `Coach` component minus the right column. It loads its own messages
    with `useApi` (`api.listCoachMessages`) and rule list (`api.listRules`, needed by
    `ProposalCard`). Replace both `setParams({}, { replace: true })` calls and `detach` with
    `setParams(withoutCorrectionParams(params), { replace: true })`. Keep
    `AttachedDialog`, `CorrectionContext`, `VerifiedSources` in the same file. Above the
    composer's cost note add the link button «Правила: N активных →» calling `onOpenRules`.
    Keep the file under ~550 lines; move `CorrectionContext` and `VerifiedSources` into
    `components/coach/CorrectionContext.tsx` if it grows past that.
  - `RepliesTab`: subtitle from the spec; `<CommunicationStyleCard readOnly={!owner} />`;
    for the owner, `RuleList` fed by `useApi(api.listRules)` with `onChanged` updating
    local state; a line «Изменения действуют только на будущие ответы.»; a secondary button
    «Исправить конкретный ответ через тренера» calling `onOpenCoach`.
  - `TrainingScreen`: `replies` → `RepliesTab`; `teach` with mode `coach` → `CoachChat`
    (the chooser comes in Task 6).
- [ ] **Step 4: Run** the full rakurs suite and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(training): add replies tab and move coach chat into teach`.

### Task 5: Generation wizard

**Files:**
- Create: `components/training/GenerationWizard.tsx`, `components/training/WizardSteps.tsx`,
  `components/training/GenerationWizard.test.tsx`
- Modify: `components/knowledge/ChatGenerationPanel.tsx` (keep the hook logic, drop render),
  `components/knowledge/GenerationRunRail.tsx`, `components/knowledge/RecentHistoryPreparation.tsx`,
  `components/knowledge/ProposalWorkspace.tsx` (wrap the audit section)

**Produces:**
```ts
// ChatGenerationPanel.tsx keeps every exported helper and gains:
export function useGenerationRun(input: { agentId: string; initialRunId: string | null; onRunId: (id: string | null) => void; readOnly: boolean }): GenerationRunController;
// GenerationRunController: { state, view, detail, busy, detailLoading, detailError, actionError, runs: { items, loading, error, hasMore, loadingMore, pageError, reload, loadMore }, start, selectRun, reloadSelectedRun, action, loadCollection, loadAllProposals, reset, collectionLoading, collectionErrors }
export function GenerationWizard(props: { agentId: string; initialRunId: string | null; onRunId: (id: string | null) => void; onOpenReplies: () => void }): JSX.Element;
export function WizardSteps(props: { current: WizardStep }): JSX.Element;
```

- [ ] **Step 1: Write render tests**:
  - `WizardSteps current="selection"`: four items «Период», «Разбор», «Отбор», «Черновик»;
    the third has `aria-current="step"`; the first two carry the class `is-done`.
  - `GenerationRunRail` renders «История разборов», «найдено фактов: 15», and neither
    «пакетов» nor «клиентских».
  - `RecentHistoryPreparation`'s button label is «Начать разбор».
  - Existing `ChatGenerationPanel.test.tsx` and `generation-polling.test.ts` still pass
    unchanged (they test exported helpers).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - Extract the body of `ChatGenerationPanel` (all state, effects, `loadRun`, `start`,
    `selectRun`, `reloadSelectedRun`, `loadMoreRuns`, `action`, `loadCollection`,
    `loadAllProposals`, `reset`) into `useGenerationRun` unchanged. Delete the
    `ChatGenerationPanel` component, its `mode` prop and `RunDraftShortcuts`.
  - `GenerationWizard` layout, top to bottom:
    1. `WizardSteps` with `wizardStep(detail, pickMore)`; `pickMore` is local state reset
       when the run id changes.
    2. `period`: one line «Стиль ответов: <label> · Изменить» (label from
       `api.getCommunicationStyle`, link calls `onOpenReplies`), then
       `RecentHistoryPreparation`.
    3. `processing`: progress bar `<progress max={batchCount} value={completedBatchCount}>`
       with «Разбираем переписку — N%», «Отменить» (existing cancel action, same disabled
       rule). Failed/cancelled: the mapped errors from `generationRunErrorPresentation`,
       «Повторить» (existing retry, failed only) and «Начать заново» (`reset`).
    4. `selection`: `ProposalWorkspace` with the same props as today. Heading
       «Отберите найденные факты». A completed run with zero proposals shows «В переписке не
       нашлось новых фактов. Ничего не изменилось.» and «Начать заново».
    5. `draft`: list of `detail.drafts` as links to `../drafts/:id` with title and status,
       primary button «Открыть на проверку» for the newest open draft, secondary «Отобрать
       ещё» setting `pickMore=true`.
    6. Below all steps: `<details className="training-history"><summary>История разборов
       (N)</summary><GenerationRunRail …/></details>`, open by default only when no run is
       selected and runs exist.
    7. `<details><summary>Подробности разбора</summary>` holding the old `RunStatus` metrics
       (tokens, cost, packet counts) — shown only when a run is selected.
  - `GenerationRunRail` copy: heading «История разборов»; empty «Разборов пока нет.»;
    metrics «найдено фактов: N», «черновиков: N», date and status; «Показать ещё».
  - `RecentHistoryPreparation`: button «Начать разбор» / busy «Запускаем разбор…»; keep
    every consent and count line.
  - `ProposalWorkspace`: wrap the excluded-batches and raw-findings sections
    (`~575-656`) in `<details><summary>Подробности разбора</summary>…</details>`; rename
    visible «Предложения» to «Найденные факты». Keep all logic.
  - Error copy in `generationRunErrorPresentation`: replace «запуск» with «разбор» and
    «Пакет N:» with «Часть N:». Update its test expectations.
- [ ] **Step 4: Run** the full rakurs suite and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(training): turn chat generation into a step-by-step wizard`.

### Task 6: Teach chooser, import mode, review list, next-step strip

**Files:**
- Create: `components/training/TeachTab.tsx`, `components/training/ReviewList.tsx`,
  `components/training/NextStepStrip.tsx`, `components/training/training.test.tsx`
- Modify: `screens/TrainingScreen.tsx`

**Produces:**
```ts
export function TeachTab(props: { agentId: string; mode: TeachMode | null; onMode: (mode: TeachMode | null) => void; generationRunId: string | null; onRunId: (id: string | null) => void; onOpenReplies: () => void; onOpenRules: () => void; onKnowledgeChanged: () => void }): JSX.Element;
export function ReviewList(props: { drafts: KbDraft[] | undefined; error: unknown; onRetry: () => void; onTeach: () => void }): JSX.Element;
export function NextStepStrip(props: { step: NextStep; onOpen: (step: Exclude<NextStep, null>) => void }): JSX.Element | null;
```

- [ ] **Step 1: Write render tests** in `training.test.tsx`:
  - `TeachTab mode={null}`: three cards with titles «Из переписки WhatsApp», «Спросить
    тренера», «Загрузить материалы» and the spec's one-line texts; no «← Все способы».
  - `TeachTab mode="import"`: contains «← Все способы» and the source card labels
    «WhatsApp», «Instagram».
  - `ReviewList` with two drafts (older coach, newer «База знаний из WhatsApp»): newest
    first, origins «Из переписки» then «Тренер», each with «Открыть»; with `[]`: «Нечего
    проверять»; with `error`: an alert and «Повторить», never «Нечего проверять».
  - `NextStepStrip`: `running` → «Идёт разбор переписки — 33%»; `review` count 3 →
    «3 черновика ждут проверки»; `empty` → «База пустая. Начните с переписки WhatsApp»;
    `null` → empty markup.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - Russian plural for the strip and list counts: add
    `export function pluralRu(n: number, one: string, few: string, many: string): string`
    to `lib/training-state.ts` with its own test (1 черновик, 3 черновика, 5 черновиков,
    11 черновиков, 21 черновик).
  - `TeachTab`: the chooser grid (card = title, text, button «Выбрать»); modes render
    `GenerationWizard`, `CoachChat`, or `KnowledgeSourceCards` (with
    `onOpenRecentHistory={() => onMode('chats')}`), each under a «← Все способы» link.
  - `ReviewList`: subtitle from the spec; table-like list sorted by `createdAt` desc; row
    shows title, `draftOrigin`, «изменений: N» (`ops.length`), `toLocaleDateString('ru-RU')`,
    link `../drafts/:id` «Открыть».
  - `NextStepStrip`: one line, accent background token, button «Открыть»; `onOpen` maps
    `running` → teach/chats with `generation=runId`, `review` → review tab, `empty` →
    teach/chats.
  - `TrainingScreen`: wire all tabs; the review tab count uses the open-drafts length;
    reload the drafts list when returning to the review tab.
- [ ] **Step 4: Run** the full rakurs suite and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(training): add teach chooser, review list and next-step strip`.

### Task 7: Styles, docs, browser verification

**Files:**
- Modify: `screens/training-workspace.css`, `docs/knowledge-base.md`,
  `docs/agent-coaching.md`

- [ ] **Step 1: Styles.** Add BEM blocks `training-strip`, `training-chooser` (3-column grid,
  one column under 900px), `training-steps` (horizontal stepper, `is-done`, `aria-current`),
  `training-review` (list rows), `training-history`. Use existing tokens
  (`--accent`, `--sunken`, `--line`, `--text-dim`). Remove the now-unused
  `knowledge-review-grid` and `knowledge-review-aside` rules. No horizontal body scroll at
  375px width.
- [ ] **Step 2: Docs.** Rewrite the owner guides to describe «Обучение агента» and its four
  tabs; each file under 500 lines (`wc -l`).
- [ ] **Step 3: Verify in the browser** on the local stand (see
  `docs/whatsapp-knowledge-release-qa.md` for starting it): as owner, each tab; the wizard
  from «Период» to «Черновик»; a «Так нельзя» link from a dialog landing in teach/coach with
  the reply attached; `/a/:id/knowledge?tab=runs&generation=<id>` and `/a/:id/coach`
  redirecting; as a non-owner, two tabs and no failing requests in the network log; both
  light and «Ночь» themes; 375px width.
- [ ] **Step 4: Run** full rakurs suite, typecheck, and `npm run build --workspace rakurs`.
- [ ] **Step 5: Commit** `docs(training): describe the merged training section` (styles in
  the same commit as `style(training): …` if separate).
