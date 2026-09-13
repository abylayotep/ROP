# Sales script

Started on: Opus 5 · Subtasks: Opus 5 (high)

The owner writes the order a sale goes in, step by step, and the reply agent follows it.
Example (Sealhouse): greeting → send design photos, customer picks one → name the standard
size and price → ask the address → explain delivery → take payment → after payment send the
finished photo.

## Decisions

- **A script is separate from the funnel.** Stages stay CRM columns; a script has as many
  steps as the owner needs. A step may point at a stage (the agent moves the lead there when
  the step starts), but does not have to.
- **The page is a chain of cards**, top to bottom with arrows. Any card can open a branch
  ("if the customer hesitates → …"). Clicking a card opens an editor panel on the right.
- **Step actions:** send catalog photos, ask lead fields, call a colleague (handoff), wait for
  payment. "Finished photo after payment" is a catalog photo, sent by the agent itself.

## Data

Table `sales_script_steps` (schema change → `drizzle-kit generate`, migration `0051_sales_script`):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `agent_id` | uuid fk agents, cascade | index `(agent_id, parent_id, position)` |
| `parent_id` | uuid fk self, cascade, null | null = main chain; else a branch under that step |
| `position` | int | order among siblings |
| `title` | text ≤ 80 | "Фото дизайнов" |
| `condition` | text ≤ 200, default '' | branches only: when the branch applies |
| `instructions` | text ≤ 2000, default '' | what the agent says and does, owner's words |
| `stage_id` | uuid fk stages, set null | optional |
| `photo_ids` | jsonb string[] ≤ 3 | catalog photo ids of this agent |
| `field_ids` | jsonb string[] ≤ 10 | lead field ids of this agent |
| `handoff` | bool default false | |
| `handoff_note` | text ≤ 200, default '' | what the colleague should do |
| `wait_payment` | bool default false | the chain does not pass this step until paid |
| `created_at`, `updated_at` | timestamptz | |

Limits: 40 steps per agent, branch depth 2 (a branch step may not have its own branches).

The conversation remembers where it is: nullable `script_step_id` (fk, set null) on the row
that already stores the lead's stage for a conversation — find it via `input.stageId` in
`server/src/lib/ai/turn.ts`.

## API (`server/src/api/sales-script.ts`, mounted like `api/rules.ts`)

- `GET /api/agents/:agentId/script` → `{ steps: ScriptStep[] }` flat, ordered; any member role.
- `PUT /api/agents/:agentId/script` → replaces the whole tree in one transaction; owner only.
  Body `{ steps: ScriptStepInput[] }` where each input carries a client id (`tmp-…` or an
  existing uuid) and `parentId` pointing at another input's id. Server validates: limits above,
  parents exist and depth ≤ 2, no cycles, `photoIds` belong to this agent's products,
  `fieldIds` to this agent's fields, `stageId` to this agent's stages. Existing uuids are kept
  (so `script_step_id` on conversations survives a save); removed steps are deleted.
- Types live in `packages/contract` next to the rule types. zod schemas like `api/stages.ts`.

## Prompt (`server/src/lib/ai/prompt.ts`)

- `TurnContext` gets `script?: PromptScriptStep[]`, `scriptStepId?: string | null`, `paid?: boolean`.
- New section `СКРИПТ ПРОДАЖ`, rendered only when the script is non-empty, placed where
  `conversationSection` is. With a script, the default numbered steps 1–6 of `ХОД РАЗГОВОРА`
  are replaced by the script; keep the principles that are not about order (no empty
  questions, one forward question per reply, answer the customer's question first, objections
  from the knowledge base, do not call a colleague when the records answer it).
- Each step renders numbered (`1`, `2`, `2.а` for branches) inside a fenced tag
  `<шаг id="…" guard="…">` with: title, condition, instructions (`quoted`), photos to send as
  `[photoId]` (only ids present in ТОВАРЫ; drop others silently), fields to ask by `[fieldId]`
  and name, handoff with note, "ждать оплату". Add `шаг` to `OUR_TAGS` and `СКРИПТ ПРОДАЖ` to
  `SECTION_NAMES`.
- Tell the model: the current step is `scriptStepId` (or the first step if null); work only on
  it; move to the next step when its goal is reached; take a branch when its condition holds
  and return to the main chain after; do not skip steps; on a step's first reply send its
  photos (overrides the "no photos without reason" part of rule 12), ask its fields one at a
  time, fill handoff if the step says so. Payment: state `Оплата: подтверждена системой` or
  `не подтверждена`; a `wait_payment` step never moves on while not confirmed, and the agent
  never claims payment was received.
- `CHECKOUT_SECTION`'s "only at step 6" precondition becomes "only at the script's payment
  step" when a script exists.
- `REPLY_SCHEMA` gets `scriptStepId` (lenient: unknown/empty → null, never rejects a reply).
  Add it to the rules' field list and both answer examples.
- Script text is an owner-written source of facts: add the rendered script instructions to
  the number sources in `turn.ts` (the `unsourcedNumber` check), or a price written in the
  script is flagged as invented.

## Turn (`server/src/lib/ai/turn.ts`)

- Load the steps (ordered) and pass them; pass `scriptStepId` from the conversation.
- `paid`: true when the lead has a paid order newer than the conversation's current sale, or
  `hasVisiblePayment` says so — reuse `server/src/lib/crm/payment.ts`, do not invent a new rule.
- After a valid reply: store `scriptStepId` if it is a step of this agent. If the new step has
  a `stage_id`, treat it as the proposed stage unless the model chose one (existing stage move
  gates, including `canMoveToSuccess`, still apply).
- Photos from a step still go through `pickPhotos` (known, unsent, capped).
- The sandbox (`api/ai-sandbox.ts`, `simulator.ts`) keeps the step in its own session state the
  same way it keeps `sentPhotoIds`.

## After payment

When payment is recognised (`server/src/lib/crm/worker.ts` paid-order insert, and Kaspi
`server/src/lib/kaspi/service.ts` paid), and the conversation's current step is a
`wait_payment` step, and the agent's automation is on and no operator has taken the
conversation: run one agent turn for that conversation with `paid: true` so it moves to the
next step and sends that step's photos. Use the existing turn queue/entry point; if there is
no safe way to start a turn without a customer message, add one that respects every gate the
normal path checks (automation off, operator took over, turn cap, dedupe). A payment recognised
twice must not send twice — key it on the order id.

## Frontend (`rakurs/`)

- New tab «Скрипт продаж» in «Обучение агента» (`TrainingScreen`, `?tab=script`, register in
  `lib/training-routes`), component `components/training/ScriptTab.tsx` + `script-tab.css`.
- Left: the chain. Each card shows number, title, one-line instructions preview, and chips
  for actions (📷 N фото, поля, «сотрудник», «ждать оплату», stage colour dot). Arrows between
  cards (CSS). "+ Шаг" between cards and at the end; "+ Ветка" on a main-chain card renders
  its branch cards indented to the right of that card with the condition on the arrow.
  Move up/down buttons; delete with confirm.
- Right panel for the selected step: title, condition (branches), «Что делает агент»
  textarea, stage select, photo picker (catalog products → their photos, thumbnails, ≤ 3),
  fields multi-select, handoff toggle + note, «Ждать оплату» toggle.
- Edits are local; one «Сохранить» button PUTs the whole tree; unsaved-changes guard; toast.
- Empty state offers «Начать с шаблона»: Приветствие → Выбор товара (фото) → Размер и цена →
  Адрес → Доставка → Оплата (ждать оплату) → После оплаты (фото). Owner then edits.
- Non-owners see it read-only. Plain CSS with tokens from `styles/tokens.css`, no new deps.
  All UI strings in Russian.

## Tests

- `server/test/ai-prompt.test.ts`: no script → no section and old steps; script → steps,
  branches, fenced tags with guard, forged tag inside instructions stripped, unknown photo ids
  dropped, paid/unpaid line, `scriptStepId` in schema parsing (lenient).
- API test file like the rules API tests: validation failures, owner-only PUT, ids kept across
  saves, cross-agent ids refused.
- Turn test: step stored, number from script not flagged, payment-triggered turn sends once.
- Frontend: component test in the style of existing `rakurs` tests for add/branch/save payload.

## Docs

Link this file from `docs/ai-agent.md`.
