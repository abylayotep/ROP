# Task 10: Dialogs label, documentation, Meta setup checklist

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Depends on every other task.

**Files:**
- Modify: `rakurs/src/screens/DialogsScreen.tsx:273`
- Modify: `docs/whatsapp-setup.md` (new sections; stays under 500 lines, it is at 94)
- Modify: `README.md` (stage table row 7)

- [ ] **Step 1: The label in the thread**

`rakurs/src/screens/DialogsScreen.tsx:273` reads

```tsx
        {mine ? ` · ${message.author === 'ai' ? 'ИИ' : 'оператор'}` : ''}
```

Replace with:

```tsx
        {mine
          ? ` · ${message.author === 'ai' ? 'ИИ' : message.author === 'phone' ? 'с телефона' : 'оператор'}`
          : ''}
```

Check the composer's reasoning for a disabled state: if it keys on `number.enabled`, an offboarded number already shows the existing «номер выключен» text. If the composer does not consult the number, leave it; the send fails with Meta's own message, which is shown verbatim.

Run `npm --prefix rakurs run typecheck && npm --prefix rakurs run build`.

- [ ] **Step 2: The owner's guide**

In `docs/whatsapp-setup.md`, rename section «2. Приложение и номер» to «2. Отдельный номер: приложение и токен» and insert a new section before it:

```markdown
## 2. Номер, который уже работает на телефоне

Если номер уже зарегистрирован в приложении **WhatsApp Business** на телефоне, удалять его
оттуда не нужно. Кабинет подключается к нему через Meta так, что телефон продолжает
работать: оператор отвечает из приложения, ИИ и кабинет — в тех же чатах. Meta называет это
Coexistence.

Что должно быть:

- номер в приложении **WhatsApp Business**, не в обычном WhatsApp;
- приложение на телефоне обновлено;
- **Meta Business Portfolio** и страница Facebook, где вы администратор;
- телефон в сети, пока идёт импорт.

Как подключить: в разделе «Интеграции» в карточке **«WhatsApp на телефоне»** нажмите
**«Подключить через Meta»**. Откроется окно Meta: выберите бизнес-портфолио, укажите номер,
подтвердите «Подключить существующий экземпляр приложения WhatsApp Business», отсканируйте
QR-код с телефона (WhatsApp Business → Настройки → Связанные устройства) и разрешите
передачу контактов и истории. После закрытия окна номер появляется в списке.

Что происходит дальше:

- Meta передаёт **контакты** и **историю чатов за 180 дней**. Импорт идёт в фоне; строка
  «Импорт истории: N %» под номером показывает, сколько дошло. Групповые чаты не передаются.
  Файлы старше 14 дней приходят как «Файл из истории телефона» без самого файла.
- Старые диалоги появляются в «Диалогах», но ИИ по ним не пишет и в воронку они не попадают,
  пока клиент не напишет снова.
- Всё, что оператор отправляет **с телефона**, видно в кабинете с пометкой «с телефона».
  ИИ в таком диалоге замолкает: человек взял разговор. Включить его обратно можно в самом
  диалоге.
- Всё, что отправлено **из кабинета** (оператор или ИИ), появляется и на телефоне.

Ограничения Meta для такого номера: 20 сообщений в секунду; в кабинет не попадают группы,
звонки, рассылки и каталог; исчезающие сообщения и «просмотр один раз» на телефоне
отключаются; связанные устройства (WhatsApp Web) придётся привязать заново.

**Отключение делается на телефоне**, а не в кабинете: WhatsApp Business → Настройки →
Аккаунт → Business Platform → Отключить. Кабинет узнаёт об этом от Meta и показывает «Телефон
отключил API». Кнопка «Удалить номер» в кабинете убирает только наши данные — переписки и
данные о рекламе — и телефон не трогает.

Если у аккаунта несколько номеров и кабинет попросил «повторите подключение и выберите
номер», пройдите окно Meta ещё раз и выберите нужный номер в нём.
```

Renumber the following sections (2→3, 3→4, …) and update the troubleshooting table with two rows:

```markdown
| В окне Meta нет пункта «Подключить приложение WhatsApp Business», только выбор аккаунта | Приложение Meta не настроено на подключение номеров с телефона. Это настройка на стороне приложения Tasbaqa (Facebook Login for Business, `featureType`), не кабинета. |
| Под номером «Meta не приняла запрос контактов и истории: …» | Meta отклонила один из двух запросов синхронизации. Они одноразовые: чтобы повторить, отключите номер на телефоне и подключите заново. |
```

- [ ] **Step 3: The Meta application checklist**

Append to `docs/whatsapp-setup.md` a final section for whoever administers the Tasbaqa application (this is done once, not per client):

```markdown
## Приложение Meta (делается один раз)

Кабинет подключает номера с телефона от имени приложения **Tasbaqa** (ID 1585667806534384).
Для этого в приложении должно быть сделано:

1. **Стать поставщиком технологий** (App Dashboard → «Стать поставщиком технологий»). Требует
   верификации бизнеса «ИП Абылай». Пока идёт проверка, подключение работает только для
   людей с ролью в приложении (Роли в приложении → Роли).
2. **Вход через Facebook для компаний → Конфигурации** → создать из шаблона «WhatsApp
   Embedded Signup» **без** варианта с истечением токена через 60 дней. ID конфигурации →
   `META_ES_CONFIG_ID`.
3. В настройках входа включить Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded
   Browser OAuth Login, Login with the JavaScript SDK; в Allowed domains и Valid OAuth
   redirect URIs — `https://rop.tasbaqa.ru`.
4. **WhatsApp → Configuration → Webhook**: адрес и verify token из «Интеграций»; поля
   `messages`, `smb_message_echoes`, `smb_app_state_sync`, `history`, `account_update`.
5. **Настройки → Основные**: App ID → `META_APP_ID`, App Secret → `META_APP_SECRET`.
6. Для чужих компаний нужен **App Review** на `whatsapp_business_management` и
   `whatsapp_business_messaging` (расширенный доступ). До него окно Meta для посторонних не
   откроется.
```

- [ ] **Step 4: README stage table**

In `README.md`'s stage table, add a row after stage 6:

```markdown
| 7 | WhatsApp с телефона: Embedded Signup, история, контакты, ответы с телефона | готово |
```

Check `wc -l docs/whatsapp-setup.md README.md deploy/README.md` — all under 500.

- [ ] **Step 5: Full check**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add rakurs/src/screens/DialogsScreen.tsx docs/whatsapp-setup.md README.md
git commit -m "Explain connecting the phone's number, and label what came from the phone"
```
