# Training workspace: merge «База знаний» and «Обучение»

Started on: Opus 5 · Subtasks: Opus 5 (session model governs)

## Problem

The owner cannot tell where anything lives or what to do first:

- «База знаний» has four tabs, two of which («Черновики», «Запуски») render the same
  `ChatGenerationPanel` with different headings.
- Communication style sits in «База знаний», while tone rules sit in «Обучение». Both shape
  live replies.
- Open drafts are listed in two places with different filters.
- The main view speaks internal vocabulary: «запуски», «пакеты», «предложения»,
  «клиентских».
- Nothing on the page says what the next useful action is.

A second, structural problem: the tabbed knowledge page (and `CommunicationStyleCard`) exists
only on `codex/semantic-release-fixed`, which production runs. `main` holds the newer
`CoachScreen` with the response-correction flow («Так нельзя»). The lines diverged
(27 commits main-only, 36 codex-only, ~20 conflicting files).

## Goals

1. One sidebar section, «Обучение агента», replacing «База знаний» and «Обучение».
2. Tabs organised by the owner's intent, not by entity.
3. Every tab and card says in one line what it is for; every empty state offers an action.
4. No feature is removed. Things move, or fold under «Подробности».
5. No backend or API change for the UI work.

## Non-goals

- Redesigning `DraftScreen` (`/a/:id/drafts/:draftId`).
- Unifying the two proposal models (`KbGenerationProposal`, `CoachProposal`) on the server.
- Changing generation, coach or correction semantics.

## Phase 0 — merge the lines

Separate branch and PR, before any UI work:

- Merge `codex/semantic-release-fixed` into `main`, resolving every conflict so both sides'
  behaviour survives (Instagram Direct, CRM, generation review, response corrections).
- Root `package-lock.json` regenerated with a root `npm install` (not `npm --prefix`), so the
  Docker `npm ci` passes.
- Acceptance: `rakurs` and `server` typecheck, full Vitest suites pass (known flaky files
  noted, not skipped silently), Docker image builds.
- No UI change in this phase.

## Phase 1 — information architecture

### Section and routes

- `SECTIONS`: replace the `knowledge` and `coach` entries with
  `{ path: 'training', label: 'Обучение агента' }`. Not `ownerOnly` — non-owners see a
  reduced page (below).
- Route `/a/:agentId/training?tab=knowledge|replies|teach|review`.
  - `teach` accepts a sub-mode `?teach=chats|coach|import`.
- Legacy redirects, preserving every other query parameter:
  - `/knowledge` → `training?tab=knowledge`
  - `/knowledge?tab=drafts|runs` → `training?tab=teach&teach=chats`
    (keeps `generation=`)
  - `/knowledge?tab=sources` → `training?tab=teach&teach=import`
  - `/coach` → `training?tab=teach&teach=coach`
    (keeps `conversation=`, `reply=`, `session=`, `turn=`)
- Every in-app link that points at `knowledge` or `coach` is updated to the new URL; the
  redirects exist for bookmarks and old notifications.

### Default tab

When `tab` is absent:

1. The owner has zero notes → `teach`.
2. Otherwise → `knowledge`.

### Visibility

- Owner: all four tabs.
- Non-owner: «Знания» and «Как отвечает», read-only. Endpoints that answer 403 to a
  non-owner are not called; their blocks are omitted, not shown as errors.

### Next-step strip

A single line under the page title, the first matching rule wins:

1. A generation run is in progress → «Идёт разбор переписки — N%» → opens the wizard.
2. Open drafts exist → «N черновиков ждут проверки» → `review`.
3. Zero notes → «База пустая. Начните с переписки WhatsApp» → wizard.
4. Otherwise no strip.

Owner only.

## Phase 1 — tabs

### «Знания» (`knowledge`)

- Subtitle: «Что агент знает о товарах, ценах и порядке работы. Агент отвечает только из этого».
- Existing note tree, search, kind filter, editor, side panel and graph, unchanged in
  behaviour.
- The tree shows notes under `Скрипт/` as a separate top-level group «Скрипт продаж».
- Empty state: text plus buttons «Научить из переписки» and «Создать заметку».

### «Как отвечает» (`replies`)

- Subtitle: «Стиль — манера речи. Правила — что агент обязан или не должен делать».
- Top: `CommunicationStyleCard` (style radio, example reply, save).
- Below: `RuleList`, grouped by the existing categories.
- A note beneath both: changes apply to future replies only.

### «Научить» (`teach`)

A chooser of three cards, then the chosen mode fills the tab, with a «← Все способы» back
link. Each card: title, one line on when to use it, one primary button.

| Card | When to use (card text) | Mode |
|---|---|---|
| Из переписки WhatsApp | «Агент сам соберёт факты и скрипт из ваших ответов клиентам» | `chats` |
| Спросить тренера | «Опишите, как отвечать, или исправьте конкретный ответ агента» | `coach` |
| Загрузить материалы | «Текст, страница сайта, Instagram или старая история WhatsApp» | `import` |

If `?teach=` is present the chooser is skipped.

#### `chats` — the wizard

A four-step indicator at the top: ① Период → ② Разбор → ③ Отбор → ④ Черновик. The step is
derived from state, never stored:

| State | Step |
|---|---|
| No selected run | ① Период: the existing preview (period, counts, what goes to the AI, the consent text) and the start button «Начать разбор» |
| Run queued/running | ② Разбор: progress bar (processed / total batches as a percentage), cancel |
| Run failed/cancelled | ② with the mapped error text, «Повторить» and «Начать заново» |
| Run completed, no draft yet | ③ Отбор: `ProposalWorkspace` (two inner tabs «База знаний» / «Скрипт продаж», selection, edit, reject) and «Собрать черновик» |
| Run completed with drafts | ④ Черновик: the draft links, «Открыть на проверку», and «Отобрать ещё» back to ③ |

- «История разборов» is a collapsed list under the wizard (`GenerationRunRail`), showing
  date, status and «найдено фактов: N». Selecting a run sets `generation=`.
- The audit block (excluded batches, raw findings, packet counts) moves under a collapsed
  «Подробности разбора».
- `CommunicationStyleCard` is no longer rendered here (it lives in «Как отвечает»); step ①
  shows one line with the current style name and a link to change it.

#### `coach`

The current `CoachScreen` conversation column: attached dialog banner, correction context,
messages with `ProposalCard`, composer, polling. The right column «Черновики на проверке» is
dropped (that is the «На проверке» tab); `RuleList` is dropped here (it is in «Как
отвечает»). A compact «Правила: N активных →» link replaces it.

#### `import`

`KnowledgeSourceCards` unchanged in behaviour (WhatsApp history, Instagram, text, web page).
The WhatsApp card's «Открыть последние 2 недели» now opens `teach=chats`.

### «На проверке» (`review`)

- Tab label carries the open-draft count: «На проверке (3)».
- Subtitle: «Изменения не видны агенту, пока вы их не примените».
- One list from `GET /drafts` (open drafts), newest first. Row: title, origin
  («Из переписки», «Тренер», «Вручную»), number of changes, created date, «Открыть» →
  `DraftScreen`.
- Origin is derived from data the list already returns; if it cannot be derived, the origin
  column is omitted rather than guessed.
- Empty state: «Нечего проверять» plus a link to «Научить».

## Vocabulary

Applies to the main view; «Подробности» may keep technical terms.

| Old | New |
|---|---|
| Запуск / Запуски | Разбор / История разборов |
| Пакеты N/M | progress percentage |
| Предложения | Найденные факты |
| клиентских (чатов) | диалогов с клиентами |
| Черновики из переписки | Из переписки WhatsApp |
| Подготовить базу знаний и скрипт | Начать разбор |

## Code layout

- `rakurs/src/screens/TrainingScreen.tsx` — tab shell, default tab, next-step strip,
  visibility.
- `rakurs/src/lib/training-routes.ts` — pure functions: parse tab/sub-mode, build URLs,
  map legacy URLs. Unit-tested.
- `rakurs/src/components/training/` — `NextStepStrip`, `TeachChooser`,
  `GenerationWizard` (+ `wizard-step.ts` pure step derivation), `ReviewList`,
  `RepliesTab`.
- `KnowledgeScreen` keeps the notes tab body only (exported as a tab component).
- `CoachScreen` is split: the conversation column becomes `components/coach/CoachChat.tsx`;
  the screen file is removed once nothing imports it.
- `ChatGenerationPanel` is split into the wizard steps; the `mode='drafts'|'runs'` prop goes
  away.
- Styles: extend `knowledge-workspace.css` into `training-workspace.css`; keep BEM naming and
  existing tokens. No new dependencies.
- Russian UI strings stay hardcoded, as elsewhere.

## Testing

- `training-routes.test.ts`: tab parsing, defaults, every legacy redirect including preserved
  query parameters.
- `wizard-step.test.ts`: every row of the state → step table.
- `TrainingScreen` render tests: owner sees four tabs; non-owner sees two and no strip; strip
  rule precedence.
- `ReviewList` test: ordering, empty state, origin omission.
- Existing knowledge, generation, proposal and coach tests move with their components and
  keep passing; `CoachScreen.interaction.test.tsx` runs against `CoachChat`.
- Manual check in the browser on the local stand: each tab, the wizard from ① to ④ against
  fixture data, a «Так нельзя» link from a dialog landing in `teach=coach`, the old URLs.

## Docs

`docs/knowledge-base.md` and `docs/agent-coaching.md` are updated to describe the single
section (owner guide), each staying under 500 lines.

## Risks

- Phase 0 conflicts in `server/src/db/schema.ts` and migrations: migration order must match
  what production already applied (production runs the codex line).
- Deep links from notifications or dialogs to `/coach?...` — covered by redirects and the
  redirect test.
- Splitting `ChatGenerationPanel` may regress polling; its existing polling tests are the
  guard.
