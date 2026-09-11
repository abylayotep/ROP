# Task 10: The integrations screen

**Files:**
- Modify: `rakurs/src/screens/IntegrationsScreen.tsx`, `rakurs/src/api/index.ts`
- Create: `rakurs/src/lib/qr.ts` (or a pinned dependency, see Step 2), `rakurs/src/screens/__tests__/linked-card.test.tsx`

**Interfaces:**
- Consumes: the three routes and `LinkedPairingEvent` from Task 9.
- Produces: nothing other code depends on.

## Steps

- [ ] **Step 1: Read the screen as it stands**

After Task 1 the screen already has two cards: «Отдельный номер» (manual) and the Embedded Signup card. This adds a third, «Телефон по QR», and one row style in the numbers list.

- [ ] **Step 2: Decide how the QR is drawn**

The server sends the QR as the raw string WhatsApp encodes; something must turn it into a matrix. Two acceptable options, in order of preference:

1. `qrcode` (MIT, no dependencies of its own) pinned exactly, rendering to a `<canvas>`. One `npm --prefix rakurs install --save-exact qrcode@<current>` plus `@types/qrcode`.
2. Render server-side into an SVG string and send that in the SSE frame.

Take option 1. A QR encoder in the bundle is small; a second content type in the event stream is a protocol.

- [ ] **Step 3: Write the failing component test**

```tsx
it('shows the QR while pairing and replaces it with the number when it opens', async () => { … });
it('shows a reason and a retry button when pairing fails', async () => { … });
it('shows «Телефон отвязал кабинет» for a logged_out number', async () => { … });
```

Match whatever testing setup `rakurs` already uses for screens; if there is none, keep this task's tests to the pure helpers and verify the rendering by hand in Step 6 — do not introduce a testing library as a side effect of this task.

- [ ] **Step 4: Build the card**

- A button «Подключить телефон по QR» → `POST …/linked`, then open an `EventSource` on the stream.
- While `pairing`: the QR canvas, redrawn on every frame, and the four steps in Russian — «Откройте WhatsApp на телефоне → Настройки → Связанные устройства → Привязка устройства».
- On `open`: replace the card with the connected number and stop the stream.
- On `failed`: the reason and a «Попробовать снова» button.
- Always visible under the card, in muted text: «Неофициальное подключение. WhatsApp может заблокировать номер.» The owner accepted that risk knowingly; the screen must not let a second person discover it by accident.

- [ ] **Step 5: The numbers list**

A `linked` row shows «Телефон по QR» as its kind, and for `linked_state = 'logged_out'` a red line «Телефон отвязал кабинет — подключите заново» with the pairing button beside it.

- [ ] **Step 6: Verify by hand, then green and commit**

```bash
npm --prefix rakurs run typecheck && npm --prefix rakurs run build
npm --prefix server test
git add -A && git commit -F - <<'MSG'
Offer the phone as a third way to connect a number

The card streams the QR the socket issues, redraws it every few seconds, and
turns into the connected number when the phone answers. It says plainly, under
the button, that this connection is unofficial and can cost the number — the
owner chose that, but the next person to open this screen did not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
