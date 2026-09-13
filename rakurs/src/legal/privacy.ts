import { list, p, type LegalTranslations } from './types';

export const privacy: LegalTranslations = {
  ru: {
    title: 'Политика конфиденциальности',
    intro: [
      'Эта политика объясняет, какие данные собирает и обрабатывает сервис «Ракурс» (rop.tasbaqa.ru; в Facebook, Instagram и WhatsApp приложение называется «Tasbaqa»), зачем они нужны, кому передаются и как их удалить.',
    ],
    sections: [
      {
        heading: '1. Кто обрабатывает данные',
        blocks: [
          p('Оператор сервиса — индивидуальный предприниматель «ИП Абылай», Республика Казахстан.'),
          p('По любым вопросам о персональных данных и их удалении пишите в Telegram: @tasbaqa_helper_bot (https://t.me/tasbaqa_helper_bot).'),
          p('Мы обрабатываем персональные данные в соответствии с Законом Республики Казахстан № 94-V «О персональных данных и их защите».'),
        ],
      },
      {
        heading: '2. О сервисе и ролях',
        blocks: [
          p('«Ракурс» — веб-приложение для бизнеса: единый кабинет для переписки с клиентами в WhatsApp и Instagram, воронки продаж и ИИ-ассистента. Публичной регистрации нет: учётные записи создаёт оператор для компаний-клиентов.'),
          p('Для данных самой компании и её сотрудников (учётные записи, настройки) оператор отвечает за обработку сам. Сообщения и контакты клиентов компании мы обрабатываем по поручению этой компании и только для неё. Компания отвечает за то, чтобы у неё было законное основание переписываться со своими клиентами и хранить их данные.'),
        ],
      },
      {
        heading: '3. Данные учётной записи',
        blocks: [
          list(
            'Адрес электронной почты сотрудника — для входа в кабинет.',
            'Пароль — хранится только в виде хеша argon2; сам пароль мы не храним и не видим.',
            'Настройки кабинета: воронка, база знаний, правила ИИ-ассистента.',
          ),
        ],
      },
      {
        heading: '4. Данные из WhatsApp Business Platform (Cloud API)',
        blocks: [
          p('Мы получаем эти данные только после того, как владелец компании сам подключит свой номер WhatsApp:'),
          list(
            'идентификатор номера телефона (phone number id), идентификатор WhatsApp Business Account, отображаемый номер и подтверждённое название компании;',
            'входящие и исходящие сообщения клиентов компании и вложения к ним — изображения, видео, аудио и документы;',
            'контакты и история переписки, которыми компания решила поделиться при подключении приложения WhatsApp Business (режим совместной работы, coexistence).',
          ),
          p('Эти данные нужны, чтобы показывать переписку во входящих, давать сотрудникам и ИИ-ассистенту отвечать клиентам, расшифровывать голосовые сообщения, вести карточку клиента и воронку продаж.'),
        ],
      },
      {
        heading: '5. Данные из Instagram (через вход с Facebook)',
        blocks: [
          p('Мы получаем эти данные только после того, как владелец компании подключит Instagram через вход с Facebook:'),
          list(
            'список страниц Facebook, которыми управляет пользователь, и связанный профессиональный аккаунт Instagram (идентификатор и имя пользователя);',
            'сообщения Direct, отправленные в этот аккаунт, и ответы, отправленные из кабинета;',
            'по желанию компании — подписи и ссылки на собственные публикации аккаунта, которые импортируются в базу знаний.',
          ),
          p('Чтобы сообщения приходили в кабинет, мы подписываем страницу на вебхуки сообщений (разрешение pages_manage_metadata).'),
        ],
      },
      {
        heading: '6. Meta Conversions API',
        blocks: [
          p('Если компания сама включит передачу событий и укажет свой набор данных (dataset) и токен, кабинет отправляет в Meta события Purchase и Lead. Событие содержит идентификатор клика по рекламе, ведущей в WhatsApp, и SHA-256 хеш номера телефона клиента. Сам номер в открытом виде не передаётся.'),
        ],
      },
      {
        heading: '7. Kaspi.kz',
        blocks: [
          p('Если компания подключит Kaspi.kz, кабинет получает и обрабатывает данные заказов и оплат, чтобы показывать их рядом с перепиской клиента.'),
        ],
      },
      {
        heading: '8. Как мы используем данные Meta Platform',
        blocks: [
          p('Данные, полученные от Meta Platform, мы используем только для того, чтобы предоставлять сервис той компании, которая их подключила. Мы:'),
          list(
            'не продаём эти данные;',
            'не используем их для рекламного профилирования;',
            'не передаём их брокерам данных;',
            'не используем их для создания или дополнения профилей пользователей в каких-либо иных целях.',
          ),
        ],
      },
      {
        heading: '9. Кому мы передаём данные',
        blocks: [
          p('Мы привлекаем только тех обработчиков, без которых сервис не работает:'),
          list(
            'Хостинг — арендованный виртуальный сервер у PS Internet Company (ps.kz), дата-центр в Алматы, Республика Казахстан. Здесь хранятся все данные кабинета.',
            'OpenRouter, Inc. — передаёт запросы ИИ провайдерам моделей (OpenAI, Google, Anthropic). Отправляется только то, что нужно для конкретного ответа или расшифровки: текст сообщений, текст базы знаний и аудио голосового сообщения. Каждая компания использует собственный ключ OpenRouter. Эти запросы могут обрабатываться за пределами Республики Казахстан.',
            'Meta Platforms — при отправке сообщений через WhatsApp и Instagram и, если компания это включила, событий Conversions API.',
            'Kaspi.kz — только если компания подключила интеграцию с Kaspi.',
          ),
          p('Мы также можем раскрыть данные, если этого требует закон Республики Казахстан.'),
        ],
      },
      {
        heading: '10. Cookie и локальное хранилище',
        blocks: [
          p('Мы не используем рекламные cookie и сторонние системы аналитики. Сервис хранит только cookie сессии для входа и настройки интерфейса (например, тему оформления) в локальном хранилище браузера.'),
        ],
      },
      {
        heading: '11. Сколько мы храним данные',
        blocks: [
          p('Данные хранятся, пока учётная запись компании активна. Это касается и сообщений, и исходных данных вебхуков. Как удалить данные раньше — через кабинет или по запросу — описано на странице https://rop.tasbaqa.ru/data-deletion.'),
        ],
      },
      {
        heading: '12. Удаление данных и ваши права',
        blocks: [
          p('Вы вправе узнать, какие ваши данные мы обрабатываем, потребовать их исправления, блокирования или удаления, а также отозвать согласие на обработку. Пошаговая инструкция по удалению данных — на странице https://rop.tasbaqa.ru/data-deletion.'),
          p('Если вы клиент компании, которая пользуется «Ракурсом», сначала обратитесь к этой компании: она распоряжается своей перепиской. Вы также можете написать нам в @tasbaqa_helper_bot — мы передадим запрос компании и поможем его выполнить.'),
        ],
      },
      {
        heading: '13. Безопасность',
        blocks: [
          list(
            'Все соединения с сервисом идут по HTTPS (TLS).',
            'Токены доступа Meta хранятся зашифрованными (AES, ключ хранится на сервере).',
            'Подпись каждого вебхука от Meta проверяется, прежде чем данные будут приняты.',
            'Доступ к серверу ограничен.',
          ),
        ],
      },
      {
        heading: '14. Дети',
        blocks: [
          p('Сервис предназначен для бизнеса и не рассчитан на лиц младше 18 лет.'),
        ],
      },
      {
        heading: '15. Изменения политики',
        blocks: [
          p('Мы можем обновлять эту политику. Актуальная версия всегда опубликована на этой странице, дата вступления в силу указана вверху.'),
        ],
      },
    ],
  },

  en: {
    title: 'Privacy Policy',
    intro: [
      'This policy explains what data the Rakurs service (rop.tasbaqa.ru; shown as "Tasbaqa" in Facebook, Instagram and WhatsApp) collects and processes, why, who it is shared with, and how to have it deleted.',
    ],
    sections: [
      {
        heading: '1. Who is responsible for your data',
        blocks: [
          p('The service is operated by the individual entrepreneur IE Abylay ("ИП Абылай"), Republic of Kazakhstan.'),
          p('For any question about personal data or its deletion, contact us on Telegram: @tasbaqa_helper_bot (https://t.me/tasbaqa_helper_bot).'),
          p('We process personal data in accordance with Law of the Republic of Kazakhstan No. 94-V "On Personal Data and Their Protection".'),
        ],
      },
      {
        heading: '2. The service and our role',
        blocks: [
          p('Rakurs is a web application for businesses: a single workspace for conversations with customers on WhatsApp and Instagram, a sales pipeline and an AI assistant. There is no public sign-up; the operator creates accounts for its business clients.'),
          p('We are responsible for data about the business and its staff (accounts, settings). Messages and contacts of the business\'s customers are processed on behalf of that business and only for it. The business is responsible for having a lawful basis to message its customers and keep their data.'),
        ],
      },
      {
        heading: '3. Account data',
        blocks: [
          list(
            'Staff email address, used to sign in.',
            'Password, stored only as an argon2 hash; we never store or see the password itself.',
            'Workspace settings: sales pipeline, knowledge base, AI assistant rules.',
          ),
        ],
      },
      {
        heading: '4. Data from the WhatsApp Business Platform (Cloud API)',
        blocks: [
          p('We receive this data only after the business owner connects their WhatsApp number:'),
          list(
            'phone number ID, WhatsApp Business Account ID, display phone number and verified business name;',
            'incoming and outgoing messages with the business\'s customers, including media: images, video, audio and documents;',
            'contacts and chat history that the business chooses to share when connecting the WhatsApp Business app (coexistence).',
          ),
          p('We use this data to show conversations in the inbox, let staff and the AI assistant reply, transcribe voice messages, and build the customer card and sales pipeline.'),
        ],
      },
      {
        heading: '5. Data from Instagram (via Facebook Login)',
        blocks: [
          p('We receive this data only after the business owner connects Instagram through Facebook Login:'),
          list(
            'the list of Facebook Pages the user manages and the linked Instagram professional account (ID and username);',
            'Direct messages sent to that account and replies sent from the app;',
            'optionally, captions and permalinks of the account\'s own posts, imported into the knowledge base.',
          ),
          p('To deliver messages to the app, we subscribe the Page to message webhooks (the pages_manage_metadata permission).'),
        ],
      },
      {
        heading: '6. Meta Conversions API',
        blocks: [
          p('If the business turns this on with its own dataset and access token, the app sends Purchase and Lead events to Meta. An event contains the click ID of the click-to-WhatsApp ad and a SHA-256 hash of the customer\'s phone number. The phone number itself is never sent in plain form.'),
        ],
      },
      {
        heading: '7. Kaspi.kz',
        blocks: [
          p('If the business connects Kaspi.kz, the app receives and processes order and payment data to show it next to the customer\'s conversation.'),
        ],
      },
      {
        heading: '8. How we use Meta Platform data',
        blocks: [
          p('We use data obtained from the Meta Platform only to provide the service to the business that connected it. We do not:'),
          list(
            'sell this data;',
            'use it for advertising or ad profiling;',
            'share it with data brokers;',
            'use it to build or augment user profiles for any other purpose.',
          ),
        ],
      },
      {
        heading: '9. Who we share data with',
        blocks: [
          p('We use only the service providers the product cannot work without:'),
          list(
            'Hosting: a rented virtual server from PS Internet Company LLP (ps.kz), data center in Almaty, Republic of Kazakhstan. All workspace data is stored there.',
            'OpenRouter, Inc. routes AI requests to model providers (OpenAI, Google, Anthropic). Only what a specific reply or transcription needs is sent: message text, knowledge base text and voice message audio. Each business uses its own OpenRouter key. These requests may be processed outside the Republic of Kazakhstan.',
            'Meta Platforms, when messages are sent through WhatsApp and Instagram and, if the business enabled it, for Conversions API events.',
            'Kaspi.kz, only if the business connected the Kaspi integration.',
          ),
          p('We may also disclose data where the law of the Republic of Kazakhstan requires it.'),
        ],
      },
      {
        heading: '10. Cookies and local storage',
        blocks: [
          p('We do not use advertising cookies or third-party analytics. The service keeps only a session cookie for sign-in and interface settings (such as the colour theme) in the browser\'s local storage.'),
        ],
      },
      {
        heading: '11. How long we keep data',
        blocks: [
          p('Data is kept while the business account is active. This applies to messages and to raw webhook payloads alike. How to have data deleted sooner, in the app or on request, is described at https://rop.tasbaqa.ru/data-deletion?lang=en.'),
        ],
      },
      {
        heading: '12. Deletion and your rights',
        blocks: [
          p('You have the right to know what data about you we process, to ask for it to be corrected, blocked or deleted, and to withdraw your consent. Step-by-step deletion instructions are at https://rop.tasbaqa.ru/data-deletion?lang=en.'),
          p('If you are a customer of a business that uses Rakurs, please contact that business first, since it controls its own conversations. You can also write to @tasbaqa_helper_bot and we will pass your request on and help carry it out.'),
        ],
      },
      {
        heading: '13. Security',
        blocks: [
          list(
            'All connections to the service use HTTPS (TLS).',
            'Meta access tokens are encrypted at rest (AES, with a key held on the server).',
            'The signature of every Meta webhook is verified before its data is accepted.',
            'Access to the server is restricted.',
          ),
        ],
      },
      {
        heading: '14. Children',
        blocks: [
          p('The service is intended for businesses and is not directed at anyone under 18.'),
        ],
      },
      {
        heading: '15. Changes to this policy',
        blocks: [
          p('We may update this policy. The current version is always published on this page, with its effective date shown at the top.'),
        ],
      },
    ],
  },
};
