# Task 5 — The screen

**Depends on:** tasks 3 and 4.
**Blocks:** task 6.

## Why

The numbers are honest; the screen is where they stop being so. Two of the three cards
describe the past completely and one starts on the day the migration ran, and an owner reading
them side by side will assume they cover the same span unless the screen says otherwise in the
place they are looking.

## Shape

`rakurs/src/screens/StatsScreen.tsx`, routed at `/a/:agentId/stats`, replacing the
`SectionScreen` placeholder. `AgentScreen.tsx` is the house style: `Card`, `CardHead`,
`Segmented`, `Async`, `EmptyState`, `Skeleton`, a local `Stat`, the same `hint` and `label`
style objects. No new dependency, and no charting library — a bar is a div with a width.

Two queries through `useApi`, not one: the snapshot has no period, and re-fetching it when the
period changes would suggest it had one.

## Card 1 — «Сейчас в воронке»

- [ ] **No period control.** The absence is the point and deserves a comment in the file: this
  is a snapshot of now, over every lead the cabinet has ever had, and it cannot be asked about
  last week.
- [ ] Sub-title, under the heading: «Снимок на сейчас. Считаются все диалоги агента, включая
  заведённые до этапа 7.»
- [ ] A row per stage: the stage's colour as a marker, its name, its count, and a bar whose
  width is the count over the largest bucket. «Без стадии» first and never hidden.
- [ ] Empty: `total === 0` → «Диалогов ещё нет. Статистика появится, когда клиент напишет в
  WhatsApp.» All leads unsorted → «Ни один диалог ещё не разобран по стадиям — все лиды в
  «Без стадии».»

## Card 2 — «Движение по воронке»

- [ ] `Segmented` with the same three periods and the same wording as `AgentScreen`'s
  `UsageCard`: «Сутки» / «Неделя» / «Месяц», and the line «За последние 7 дней, с 27 августа».
  Reuse the `PERIODS` shape; a second spelling of the same three buttons is a second thing to
  keep in step.
- [ ] Always, directly under the title: «Переходы записываются с {stageHistorySince}.»
- [ ] When `since < stageHistorySince`, a band in `var(--warn)` the owner cannot miss:
  «Период начинается раньше, чем кабинет начал записывать переходы. Всё, что было до
  {дата}, здесь не учтено — сколько лидов где стоит сейчас, показывает карточка выше.»
  This is the one sentence that stops the funnel being read as a claim about the past.
- [ ] Steps in order: name, `entered`, and the conversion to the next step as a percentage.
  `conversion === null` renders «—» with a title explaining there was nothing to divide by;
  it must never render «0 %».
- [ ] `backwardMoves`, `failureEntries` as `Stat` tiles. `deletedStageEntries` only when it is
  not zero: «{n} переходов в стадии, которых больше нет: {names}.»
- [ ] Empty: `funnel.every(step => step.entered === 0)` → «За этот период лидов по воронке не
  двигали. Переходы записываются с {дата} — всё, что было раньше, в этой карточке не учтено.»
  Never a column of zeros.
- [ ] Neither card is called «воронка» alone. One is «Сейчас в воронке», the other «Движение по
  воронке», and they carry different controls and different date lines.

## Card 3 — «Источники и деньги»

- [ ] The same period as card 2 — one `Segmented`, shared state, so the two cannot disagree.
- [ ] Sub-title: «Считается по всем диалогам, начавшимся за период. Деньги — по всем их
  оплатам, даже если оплата пришла позже.»
- [ ] Money tiles from `money`: «Оплачено», «Заказов», «Средний чек», «На одного лида».
  `money === null` → «За период нет оплаченных заказов. Заказ попадает сюда, когда его
  отмечают оплаченным в карточке лида.» `averageOrder` / `revenuePerLead` null → «—», not «0».
- [ ] `otherCurrencyOrders > 0` → a hint line: «{n} оплаченных заказов в другой валюте в эти
  суммы не входят.»
- [ ] A table per source: заголовок объявления (or the id, or «Реклама без идентификатора
  объявления» for the `null` row), лидов, из них с идентификатором клика, продаж, оплачено.
- [ ] A line above it: «Из {newLeads} новых диалогов {leadsFromAds} пришли с рекламы.»
- [ ] Empty: `sources.length === 0` → «Ни один диалог за период не пришёл с рекламы. Сюда
  попадают только переходы по Click-to-WhatsApp.»
- [ ] Unlike card 2, this card carries **no** «записывается с» warning, and a comment says why:
  the advertising columns have been filled for every click since the number was connected, so
  these numbers are honest about the past and must not be hedged as though they were not.

## Money formatting

- [ ] A local `money(value: string, currency: string)` that **never** calls `Number()` or
  `toLocaleString`. Split on `'.'`, group the integer part in threes with a non-breaking space
  from the right, join the fraction with `','`, append the currency. Comment it against
  `AgentScreen`'s `money()`, which does parse to a number: that one prints fractions of a US
  cent for an OpenRouter bill, and this one prints the company's revenue, which must not round.
- [ ] Counts are numbers and may use `toLocaleString('ru-RU')`, exactly as `UsageCard` does.

## Wiring

- [ ] `rakurs/src/lib/sections.ts`: clear the `stats` entry's `pending` to `''`.
- [ ] Route the screen where the other real screens are routed.
- [ ] `rakurs/src/api/index.ts`: both functions, with Russian doc comments in the file's style,
  including the note that `money` arrives `null` when nothing was paid and that this is not the
  same as zero.

## Acceptance criteria

- [ ] `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build` green.
- [ ] `npm --prefix server test` and `run typecheck` still green.
- [ ] Every empty branch listed above renders a sentence. Walk them by hand against a fresh
  agent with no conversations, an agent with untriaged leads only, and an agent with leads but
  no ad clicks — three states, three different sentences, no zeros.
- [ ] Choosing «Месяц» on a cabinet migrated today shows the warning band.
- [ ] Grep the file: no `Number(`, no `parseFloat`, no `toLocaleString` applied to a money
  string.

## Before task 6 starts

The screen is real for all three empty states and for a seeded agent, so the documentation can
describe what an owner actually sees rather than what was intended.
