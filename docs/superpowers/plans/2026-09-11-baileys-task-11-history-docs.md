# Task 11: History import, outgoing media, docs

**Files:**
- Create: `server/src/lib/whatsapp/linked/history.ts`, `server/test/linked-history.test.ts`, `docs/whatsapp-linked.md`
- Modify: `server/src/api/conversations.ts`, `rakurs/src/screens/DialogsScreen.tsx`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `registerLinkedHistory(db, deps, client): void`.

## Part A — history import

- [ ] **Step 1: Write the failing tests**

```ts
it('writes contacts, conversations and messages from a history chunk', async () => { … });

it('never runs a turn for an imported message', async () => {
  // a chunk containing a customer question → zero model calls
});

it('does not overwrite a contact name the cabinet already has', async () => { … });

it('imports the same chunk twice without duplicating a message', async () => { … });

it('does not download media during the import', async () => {
  // chunk with an image → row stored, media_path null, downloadMedia never called
});

it('skips group chats in a history chunk', async () => { … });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm --prefix server test -- linked-history
```

- [ ] **Step 3: Implement**

`registerLinkedHistory` handles the client's `history` event. For each message in the chunk: `normalize` (the same function Task 6 wrote — a history message and a live one are the same shape), then the same writers, with two differences that are the whole point of the file:

- `runTurns` is never called. Answering a question from four months ago is worse than not answering it.
- media is not downloaded. The row keeps its message so the conversation reads correctly, and the file is fetched the first time someone opens it.

Contacts fill `contacts.name` only where it is currently null.

Imported conversations land in the funnel's first stage and do not move on their own.

## Part B — sending media from the cabinet

- [ ] **Step 4: Write the failing test**

```ts
it('sends an image through the linked transport and stores it as an operator line', async () => { … });
it('refuses a file larger than the limit with a Russian sentence', async () => { … });
```

- [ ] **Step 5: Implement**

`POST /api/agents/:agentId/conversations/:conversationId/messages` accepts `multipart/form-data` in addition to JSON: one file part plus an optional caption. Register `@fastify/multipart`, pinned, and cap the size at 16 MB — WhatsApp's own document limit, so a file the cabinet accepts is a file WhatsApp will take.

The file is written through `storeInboundMedia` (Task 6) before sending, so a sent image is served by the same media route as a received one, then `transport.sendMedia(...)`. On a Cloud API number the graph wrapper answers `501` with «Отправка файлов пока работает только для номера, подключённого по QR.» — keeping the route honest instead of pretending.

## Part C — documentation

- [ ] **Step 6: Write `docs/whatsapp-linked.md`**

Under 500 lines, and it must contain, in this order:

1. **What this is and what it costs** — a linked device, not Meta; the terms are violated; the number can be banned; no click-to-WhatsApp attribution. Plain sentences, no hedging.
2. **How to connect** — Интеграции → «Подключить телефон по QR» → WhatsApp → Настройки → Связанные устройства → Привязка устройства → scan.
3. **What arrives** — messages both ways, the owner's own replies from the phone, the recent history after pairing.
4. **What does not work** — groups, calls, reactions, read receipts, statuses; CAPI attribution.
5. **When it breaks** — «Телефон не на связи» versus «Телефон отвязал кабинет», and what to do about each.
6. **How to move to the official path later** — the coexistence card, and that conversations survive the switch.

Link it from `README.md` beside `docs/whatsapp-setup.md`.

- [ ] **Step 7: Label the source in Диалоги**

`DialogsScreen` already labels `author === 'phone'` as «с телефона» after Task 1. Confirm an imported line renders the same way and nothing says «Meta» on a linked conversation.

- [ ] **Step 8: Green everything and commit**

```bash
npm --prefix server test && npm --prefix server run typecheck
npm --prefix rakurs run typecheck && npm --prefix rakurs run build
git add -A && git commit -F - <<'MSG'
Import the phone's recent chats, send files, write it all down

History is written through the same writers as a live message and answers
nothing: a question from four months ago does not want a reply today. Media
arrives lazily, because importing months of files at pairing time is a long
wait for bytes most conversations will never be scrolled back to.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
