# Task 12: Documentation and deployment

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

The stage is not finished when the code works. Someone has to be able to connect a number
without reading the source, and the deployed stack has to keep the files and reach the webhook.

**Files:**
- Create: `docs/whatsapp-setup.md`
- Modify: `README.md`, `deploy/README.md`, `deploy/compose.yml`, `deploy/nginx.conf`,
  `deploy/env.example`

**Interfaces:**
- Consumes: everything the stage built.
- Produces: nothing.

---

- [ ] **Step 1: Write the setup guide**

Create `docs/whatsapp-setup.md`, in Russian, under 200 lines. It is written for the person who
owns the Meta account, not for a developer. It covers, in order:

1. **Что нужно заранее** — Meta Business Portfolio, приложение типа Business, продукт WhatsApp,
   отдельная SIM, которой ещё не пользовались в WhatsApp.
2. **Приложение и номер** — где в Meta лежат `Phone number ID` и `WhatsApp Business Account ID`
   (WhatsApp → API Setup), как выпустить постоянный токен системного пользователя вместо
   временного на 24 часа, и почему временный использовать не стоит.
3. **Вебхук** — куда вставить адрес и проверочную строку из раздела «Интеграции», и что нужно
   отметить поле `messages`, иначе Meta ничего не пришлёт.
4. **Подключение в кабинете** — три поля, кнопка, что происходит при нажатии: проверка токена и
   подписка приложения на WABA.
5. **Проверка** — написать на подключённый номер с телефона и увидеть сообщение в «Диалогах»;
   ответить из кабинета и увидеть ответ в телефоне.
6. **Что бывает не так** — четыре случая с признаком и причиной:
   - сообщения не приходят, а номер выглядит подключённым: приложение не подписано на WABA или
     в вебхуке не отмечено поле `messages`;
   - Meta отвергает токен: временный токен протух, нужен постоянный;
   - ответ не уходит с ошибкой про 24 часа: окно закрыто, нужен шаблон, а шаблоны появятся позже;
   - ответ не уходит с текстом про allowed list: у номера тестовый режим, получатель не добавлен
     в список разрешённых.
7. **Ограничения на старте** — 250 уникальных собеседников в сутки до верификации бизнеса.

Every claim in this file must match what the code does. Where the wording of an error is quoted,
quote it exactly as the server sends it.

- [ ] **Step 2: Point the README at it**

In `README.md`:

- move stage 2 in the stage table from «дальше» to «готово», and stage 3 to «дальше»;
- under «Что уже работает», say that WhatsApp is connected through the official Cloud API,
  conversations are stored and answered from the cabinet, and the ad a conversation came from is
  recorded for the Conversions API stage;
- add one line pointing at `docs/whatsapp-setup.md` for connecting a number;
- list the five new environment variables in the local-setup section, saying that
  `CREDENTIALS_KEY` is generated with `head -c 32 /dev/urandom | base64` and that without a
  public address for the webhook the cabinet works but no message arrives.

- [ ] **Step 3: Keep the files across deployments**

In `deploy/compose.yml`, give the api service a named volume for media and pass the new
variables:

```yaml
    environment:
      META_APP_SECRET: ${META_APP_SECRET}
      META_WEBHOOK_VERIFY_TOKEN: ${META_WEBHOOK_VERIFY_TOKEN}
      CREDENTIALS_KEY: ${CREDENTIALS_KEY}
      MEDIA_DIR: /var/lib/rakurs/media
      PUBLIC_URL: ${PUBLIC_URL}
    volumes:
      - media:/var/lib/rakurs/media
```

and declare `media:` beside the existing volumes. A bind mount would be wrong here: the files
belong to the container's lifecycle, not to the checkout, and the point of the volume is that
`docker compose down` does not take a client's photographs with it.

- [ ] **Step 4: Let the webhook through nginx**

In `deploy/nginx.conf`, nothing routes differently — `/api` already proxies — but two things
need saying and one needs setting:

```nginx
    # Meta posts webhook deliveries here. The signature is over the exact bytes, so nothing
    # in front of the application may rewrite the body.
    client_max_body_size 1m;
```

Add a comment above the `/api` block naming `/api/whatsapp/webhook` as the address given to
Meta, so nobody later adds a rule that strips or rewrites it.

- [ ] **Step 5: Finish the deployment notes**

In `deploy/README.md`:

- add the five variables to the list of what `deploy/.env` must hold, with one line each;
- say that `PUBLIC_URL` must be the real domain, because the integrations screen builds the
  webhook address from it and a wrong value sends Meta somewhere else;
- add a line to the update procedure noting that the media volume survives `down` and `up`, and
  that removing it loses every file clients sent.

- [ ] **Step 6: Read what you wrote against the code**

Open `docs/whatsapp-setup.md`, `README.md` and `deploy/README.md` and check every statement
against the code as it now stands: the route paths, the exact error strings, the variable names,
the npm commands. A guide that is almost right costs more than no guide, because the reader
trusts it.

- [ ] **Step 7: Check every gate**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: PASS, all four.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Document connecting WhatsApp and keep media across deployments"
```
