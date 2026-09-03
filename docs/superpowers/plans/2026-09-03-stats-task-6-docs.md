# Task 6 — Documentation

**Depends on:** task 5.
**Blocks:** nothing. This is the last task of the last stage.

## Why

The one thing an owner can get wrong about this screen is believing the funnel covers the
months before it shipped. The screen says so in two places; the documentation is where the
reason lives, so «почему воронка пустая» has an answer that is not a support conversation.

## `docs/statistics.md`

New, in Russian, in the style of `docs/orders-funnel.md` and `docs/meta-capi.md`, under 500
lines and comfortably shorter than that. It covers, in this order:

- [ ] **Что здесь считается** — три карточки, и чем «Сейчас в воронке» отличается от
  «Движения по воронке». Одним абзацем: первая — про сейчас и про всех, вторая — про период и
  только про то, что кабинет записал.
- [ ] **Почему воронка начинается сегодня.** Прямым текстом: до этапа 7 кабинет хранил только
  ту стадию, в которой лид стоит, и не хранил, где он был раньше. Восстановить это не из чего.
  Дата, с которой идёт запись, написана на самой карточке. Всё, что было до неё, в движении по
  воронке не участвует — и это не поломка.
- [ ] **Что честно про прошлое:** распределение по стадиям, источники рекламы (с того дня, как
  подключили номер) и оплаченные заказы. Эти три считаются за любой период целиком.
- [ ] **Как читать конверсию.** Лид, которого перетащили через стадию, в неё не попал — так и
  показано. Прочерк вместо процента значит, что делить не на что, а не ноль. Возврат назад
  считается переходом и виден отдельной цифрой.
- [ ] **Деньги.** Складываются только заказы в валюте агента; заказы в другой валюте не входят
  в суммы и посчитаны отдельной строкой. Средний чек округлён до копеек. «На одного лида» —
  прочерк, когда лидов за период не было.
- [ ] **Источники.** Деньги считаются по всем оплатам диалогов, начавшихся за период, даже если
  оплата пришла позже, — поэтому цифра за прошлый месяц может вырасти. Так и задумано: реклама
  привела клиента тогда.
- [ ] **Чего здесь нет:** графиков, выгрузки в CSV (лиды выгружаются на доске) и рейтинга
  сотрудников.
- [ ] Ссылки: на `docs/orders-funnel.md` за тем, как настраиваются стадии, и на
  `docs/meta-capi.md` за тем, откуда берётся реклама.

## `README.md`

- [ ] The roadmap table: stage 7's «Состояние» becomes `готово`.
- [ ] A paragraph in «Что уже работает», after the Meta CAPI one, in the same voice: что
  показывает статистика, и одной фразой — что движение по воронке считается с момента, как
  кабинет начал его записывать, а распределение, источники и деньги честны за всё прошлое.
  Ссылка на `docs/statistics.md`.
- [ ] Delete the sentence «Остальные разделы показывают, на каком этапе они появятся» and the
  paragraph around it **only if** no section is left pending after this stage. Check
  `rakurs/src/lib/sections.ts`: every `pending` should now be `''`. If one is not, leave the
  sentence and say which section it is about.
- [ ] Leave «Правила, которые легко нарушить» alone. Nothing in this stage changes those rules,
  and this stage is an application of the third one — «Ноль вместо "не знаем" — ошибка» —
  rather than an amendment to it.

## Acceptance criteria

- [ ] `docs/statistics.md` exists, is under 500 lines, and states in its own words that the
  funnel starts on the day the migration ran and cannot be backfilled.
- [ ] README's roadmap row for stage 7 says готово, and the new paragraph links the doc.
- [ ] `wc -l` on every `.md` this stage touched is under 500.
- [ ] `npm --prefix server test`, `npm --prefix server run typecheck`,
  `npm --prefix rakurs run typecheck`, `npm --prefix rakurs run build` — all green, one last
  time, on the finished branch.
