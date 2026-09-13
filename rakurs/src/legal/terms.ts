import { list, p, type LegalTranslations } from './types';

export const terms: LegalTranslations = {
  ru: {
    title: 'Условия использования',
    intro: [
      'Эти условия регулируют использование сервиса «Ракурс» (rop.tasbaqa.ru). Пользуясь сервисом, компания и её сотрудники соглашаются с ними.',
    ],
    sections: [
      {
        heading: '1. Кто предоставляет сервис',
        blocks: [
          p('Сервис предоставляет индивидуальный предприниматель «ИП Абылай», Республика Казахстан (далее — «мы»). «Ракурс» — веб-приложение для бизнеса: переписка с клиентами в WhatsApp и Instagram, воронка продаж, база знаний и ИИ-ассистент.'),
        ],
      },
      {
        heading: '2. Учётная запись',
        blocks: [
          list(
            'Учётные записи создаём мы для компаний-клиентов; публичной регистрации нет.',
            'Компания отвечает за действия своих сотрудников в кабинете и за то, кому она выдаёт доступ.',
            'Храните пароль в секрете. Если вы подозреваете, что доступ к учётной записи получил посторонний, сразу сообщите нам.',
          ),
        ],
      },
      {
        heading: '3. Ответственность компании',
        blocks: [
          p('Компания, которая пользуется сервисом, самостоятельно отвечает за то, чтобы:'),
          list(
            'у неё было законное основание переписываться со своими клиентами и обрабатывать их персональные данные;',
            'её переписка соответствовала законодательству, WhatsApp Business Policy, условиям Meta Platform Terms и условиям использования Instagram;',
            'подключаемые номера, страницы и аккаунты принадлежали ей или использовались с разрешения владельца.',
          ),
        ],
      },
      {
        heading: '4. Запрещённое использование',
        blocks: [
          p('Нельзя использовать сервис для:'),
          list(
            'рассылки спама и нежелательных сообщений;',
            'распространения незаконного, вводящего в заблуждение или оскорбительного контента;',
            'мошенничества и нарушения прав других лиц;',
            'попыток получить несанкционированный доступ к сервису, чужим данным или нарушить его работу.',
          ),
        ],
      },
      {
        heading: '5. Ответы ИИ-ассистента',
        blocks: [
          p('ИИ-ассистент формирует ответы автоматически, и они могут содержать ошибки или неточности. Компания сама решает, включать ли автоматические ответы, и отвечает за всё, что отправлено её клиентам из кабинета, — как сотрудниками, так и ассистентом.'),
        ],
      },
      {
        heading: '6. Доступность сервиса',
        blocks: [
          p('Сервис предоставляется «как есть». Мы стараемся, чтобы он работал стабильно, но не гарантируем бесперебойную работу. Работа сервиса также зависит от внешних платформ — Meta, OpenRouter, Kaspi.kz, — изменения и сбои которых мы не контролируем.'),
        ],
      },
      {
        heading: '7. Прекращение доступа',
        blocks: [
          p('Компания может в любой момент перестать пользоваться сервисом и попросить удалить учётную запись — см. https://rop.tasbaqa.ru/data-deletion. Мы можем приостановить или прекратить доступ, если компания нарушает эти условия, правила Meta или закон.'),
        ],
      },
      {
        heading: '8. Ограничение ответственности',
        blocks: [
          p('В пределах, допустимых законом, мы не несём ответственности за косвенные убытки, упущенную выгоду, потерю данных или блокировку аккаунтов внешними платформами, а также за содержание сообщений, отправленных компанией или её ИИ-ассистентом.'),
        ],
      },
      {
        heading: '9. Персональные данные',
        blocks: [
          p('Как мы обрабатываем данные, описано в политике конфиденциальности: https://rop.tasbaqa.ru/privacy.'),
        ],
      },
      {
        heading: '10. Применимое право',
        blocks: [
          p('К этим условиям применяется право Республики Казахстан. Споры решаются в соответствии с законодательством Республики Казахстан.'),
        ],
      },
      {
        heading: '11. Изменения и контакты',
        blocks: [
          p('Мы можем обновлять эти условия; актуальная версия всегда опубликована на этой странице. Вопросы по условиям пишите в Telegram: @tasbaqa_helper_bot (https://t.me/tasbaqa_helper_bot).'),
        ],
      },
    ],
  },

  en: {
    title: 'Terms of Service',
    intro: [
      'These terms govern the use of the Rakurs service (rop.tasbaqa.ru). By using the service, a business and its staff agree to them.',
    ],
    sections: [
      {
        heading: '1. Who provides the service',
        blocks: [
          p('The service is provided by the individual entrepreneur IE Abylay ("ИП Абылай"), Republic of Kazakhstan ("we", "us"). Rakurs is a web application for businesses: customer conversations on WhatsApp and Instagram, a sales pipeline, a knowledge base and an AI assistant.'),
        ],
      },
      {
        heading: '2. Accounts',
        blocks: [
          list(
            'We create accounts for our business clients; there is no public sign-up.',
            'The business is responsible for what its staff do in the workspace and for who it gives access to.',
            'Keep your password secret. If you suspect someone else has accessed your account, tell us right away.',
          ),
        ],
      },
      {
        heading: '3. Business responsibilities',
        blocks: [
          p('A business using the service is solely responsible for making sure that:'),
          list(
            'it has a lawful basis to message its customers and process their personal data;',
            'its messaging complies with applicable law, the WhatsApp Business Policy, the Meta Platform Terms and the Instagram Terms of Use;',
            'the numbers, Pages and accounts it connects belong to it or are used with the owner\'s permission.',
          ),
        ],
      },
      {
        heading: '4. Prohibited use',
        blocks: [
          p('You may not use the service to:'),
          list(
            'send spam or unsolicited messages;',
            'distribute unlawful, misleading or abusive content;',
            'commit fraud or violate the rights of others;',
            'attempt to gain unauthorised access to the service or other people\'s data, or disrupt its operation.',
          ),
        ],
      },
      {
        heading: '5. AI assistant replies',
        blocks: [
          p('The AI assistant generates replies automatically, and they may contain mistakes or inaccuracies. The business decides whether to turn automatic replies on and is responsible for everything sent to its customers from the workspace, whether by staff or by the assistant.'),
        ],
      },
      {
        heading: '6. Availability',
        blocks: [
          p('The service is provided "as is". We work to keep it reliable but do not guarantee uninterrupted operation. The service also depends on external platforms such as Meta, OpenRouter and Kaspi.kz, whose changes and outages are outside our control.'),
        ],
      },
      {
        heading: '7. Termination',
        blocks: [
          p('A business can stop using the service at any time and ask for its account to be deleted; see https://rop.tasbaqa.ru/data-deletion?lang=en. We may suspend or terminate access if a business breaches these terms, Meta\'s policies or the law.'),
        ],
      },
      {
        heading: '8. Limitation of liability',
        blocks: [
          p('To the extent permitted by law, we are not liable for indirect losses, lost profits, loss of data or account restrictions imposed by external platforms, or for the content of messages sent by a business or its AI assistant.'),
        ],
      },
      {
        heading: '9. Personal data',
        blocks: [
          p('How we process data is described in the Privacy Policy: https://rop.tasbaqa.ru/privacy?lang=en.'),
        ],
      },
      {
        heading: '10. Governing law',
        blocks: [
          p('These terms are governed by the law of the Republic of Kazakhstan. Disputes are resolved in accordance with the legislation of the Republic of Kazakhstan.'),
        ],
      },
      {
        heading: '11. Changes and contact',
        blocks: [
          p('We may update these terms; the current version is always published on this page. For questions about these terms, contact us on Telegram: @tasbaqa_helper_bot (https://t.me/tasbaqa_helper_bot).'),
        ],
      },
    ],
  },
};
