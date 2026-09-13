import { list, p, steps, type LegalTranslations } from './types';

export const dataDeletion: LegalTranslations = {
  ru: {
    title: 'Удаление данных',
    intro: [
      'На этой странице описано, как удалить данные из сервиса «Ракурс» (rop.tasbaqa.ru), включая данные, полученные от Meta (WhatsApp, Instagram, Facebook). Есть три способа — выберите тот, который вам нужен.',
    ],
    sections: [
      {
        heading: 'Способ 1. Удалить данные в кабинете',
        blocks: [
          p('Подходит владельцу компании, у которого есть доступ к кабинету.'),
          steps(
            'Войдите на https://rop.tasbaqa.ru и откройте нужную компанию.',
            'Перейдите в раздел «Интеграции».',
            'WhatsApp: у подключённого номера нажмите «Удалить номер» и подтвердите. Номер удаляется вместе со всеми переписками, сообщениями и данными о рекламе, из которой пришли клиенты. Отменить это нельзя.',
            'Instagram Direct: нажмите «Выключить» — кабинет перестанет принимать сообщения из Instagram. Чтобы удалить уже полученную переписку Instagram, воспользуйтесь способом 3.',
            'Meta Conversions API: нажмите «Убрать набор данных» — настройки и токен будут удалены, события в Meta больше не отправляются.',
            'База знаний: в разделе «База знаний» удалите ненужные источники и заметки кнопкой «Удалить», в том числе импортированные публикации Instagram.',
          ),
        ],
      },
      {
        heading: 'Способ 2. Отозвать доступ приложения в Meta',
        blocks: [
          p('После этого приложение больше не сможет получать новые данные из вашего аккаунта. Уже сохранённые данные при этом не удаляются — для этого используйте способ 1 или 3.'),
          steps(
            'Facebook: откройте «Настройки и конфиденциальность» → «Настройки» → «Безопасность» → «Бизнес-интеграции» (или «Приложения и сайты»).',
            'Найдите приложение «Ракурс» и нажмите «Удалить».',
            'WhatsApp: в WhatsApp Manager (business.facebook.com) откройте настройки аккаунта WhatsApp Business → «Партнёры» и удалите партнёра.',
          ),
        ],
      },
      {
        heading: 'Способ 3. Полностью удалить учётную запись и все данные',
        blocks: [
          p('Так удаляется учётная запись компании и все связанные с ней данные, в том числе всё, что было получено от Meta.'),
          steps(
            'Напишите в Telegram @tasbaqa_helper_bot (https://t.me/tasbaqa_helper_bot) с просьбой удалить данные.',
            'Укажите адрес электронной почты учётной записи или название и номер подключённой компании (WhatsApp-номер или аккаунт Instagram).',
            'Мы подтвердим, что запрос отправил владелец учётной записи или компании.',
            'Мы удалим учётную запись и все связанные данные в течение 30 дней.',
          ),
          p('Исключение — записи, которые мы обязаны хранить по закону (например, сведения об оплатах). Они хранятся столько, сколько требует закон, и не используются ни для чего другого.'),
        ],
      },
      {
        heading: 'Если вы клиент компании',
        blocks: [
          p('Если вы переписывались с компанией, которая пользуется «Ракурсом», и хотите удалить свою переписку, обратитесь к этой компании. Вы также можете написать нам в @tasbaqa_helper_bot — мы передадим запрос компании и поможем его выполнить.'),
        ],
      },
      {
        heading: 'Что удаляется',
        blocks: [
          list(
            'учётные записи сотрудников компании;',
            'подключённые номера WhatsApp, аккаунты Instagram и их токены доступа;',
            'переписки, сообщения и вложения, контакты и карточки клиентов;',
            'база знаний, настройки ИИ-ассистента и Conversions API, данные заказов Kaspi.',
          ),
          p('Подробнее о том, какие данные мы обрабатываем, — в политике конфиденциальности: https://rop.tasbaqa.ru/privacy.'),
        ],
      },
    ],
  },

  en: {
    title: 'Data Deletion Instructions',
    intro: [
      'This page explains how to delete your data from the Rakurs service (rop.tasbaqa.ru), including data received from Meta (WhatsApp, Instagram, Facebook). There are three options; pick the one you need.',
    ],
    sections: [
      {
        heading: 'Option 1. Delete data in the app',
        blocks: [
          p('For a business owner who has access to the workspace.'),
          steps(
            'Sign in at https://rop.tasbaqa.ru and open your business.',
            'Go to the «Интеграции» (Integrations) section.',
            'WhatsApp: next to the connected number, click «Удалить номер» (Delete number) and confirm. The number is deleted together with all its conversations, messages and ad attribution data. This cannot be undone.',
            'Instagram Direct: click «Выключить» (Turn off) and the app stops receiving Instagram messages. To delete Instagram conversations already received, use option 3.',
            'Meta Conversions API: click «Убрать набор данных» (Remove dataset). The settings and access token are deleted and no more events are sent to Meta.',
            'Knowledge base: in «База знаний» (Knowledge base), delete sources and notes you no longer need with «Удалить» (Delete), including imported Instagram posts.',
          ),
        ],
      },
      {
        heading: 'Option 2. Remove the app\'s access in Meta',
        blocks: [
          p('After this the app can no longer receive new data from your account. Data already stored is not deleted by this step; use option 1 or 3 for that.'),
          steps(
            'Facebook: open Settings & privacy → Settings → Security → Business Integrations (or Apps and Websites).',
            'Find the Rakurs app and click Remove.',
            'WhatsApp: in WhatsApp Manager (business.facebook.com), open your WhatsApp Business Account settings → Partners and remove the partner.',
          ),
        ],
      },
      {
        heading: 'Option 3. Delete your account and all data',
        blocks: [
          p('This deletes the business account and all data associated with it, including everything received from Meta.'),
          steps(
            'Message @tasbaqa_helper_bot on Telegram (https://t.me/tasbaqa_helper_bot) asking for your data to be deleted.',
            'Include the account email address, or the name and number of the connected business (WhatsApp number or Instagram account).',
            'We confirm that the request comes from the owner of the account or business.',
            'We delete the account and all associated data within 30 days.',
          ),
          p('The only exception is records we are required by law to keep (for example, payment records). They are kept only as long as the law requires and are not used for anything else.'),
        ],
      },
      {
        heading: 'If you are a customer of a business',
        blocks: [
          p('If you messaged a business that uses Rakurs and want your conversation deleted, please contact that business. You can also write to @tasbaqa_helper_bot and we will pass your request on and help carry it out.'),
        ],
      },
      {
        heading: 'What gets deleted',
        blocks: [
          list(
            'staff accounts of the business;',
            'connected WhatsApp numbers, Instagram accounts and their access tokens;',
            'conversations, messages and media, contacts and customer cards;',
            'knowledge base, AI assistant and Conversions API settings, Kaspi order data.',
          ),
          p('For details on what data we process, see the Privacy Policy: https://rop.tasbaqa.ru/privacy?lang=en.'),
        ],
      },
    ],
  },
};
