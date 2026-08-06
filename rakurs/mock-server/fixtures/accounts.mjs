
/** Рекламные аккаунты Meta Business, доступные владельцу бизнеса. */
export const adAccounts = [
  {
    id: 'act_1',
    num: 'act_284910384',
    name: 'Лофт · Основной',
    currency: 'USD',
    creatives: 31,
    status: 'Синхронизирован',
    statusFg: 'var(--accent)',
  },
  {
    id: 'act_2',
    num: 'act_771204558',
    name: 'Лофт · Ретаргет',
    currency: 'USD',
    creatives: 16,
    status: 'Синхронизирован',
    statusFg: 'var(--accent)',
  },
  {
    id: 'act_3',
    num: 'act_339857712',
    name: 'Лофт · Тесты',
    currency: 'USD',
    creatives: 24,
    status: 'Синхронизирован',
    statusFg: 'var(--accent)',
  },
  {
    id: 'act_4',
    num: 'act_910338271',
    name: 'Агентство «Прайм» (партнёр)',
    currency: 'KZT',
    creatives: 58,
    status: 'Нужен доступ',
    statusFg: 'var(--warn)',
    // Партнёрский аккаунт не читается, расход виден только в сводке Business Manager.
    spendOverride: '4,1 млн ₸',
  },
];

export const syncModes = ['Каждый час', 'Раз в день', 'Вручную'] ;

/** Номера продавцов, подключённые по QR. */
export const whatsappNumbers = [
  {
    phone: '+7 701 448 22 90',
    owner: 'Асель Нурланова',
    dialogs: '460',
    status: 'Читается',
    statusFg: 'var(--accent)',
    dot: 'var(--accent-2)',
    since: 'с 12 мая',
    action: 'Отключить',
  },
  {
    phone: '+7 705 331 07 14',
    owner: 'Данияр Ким',
    dialogs: '426',
    status: 'Читается',
    statusFg: 'var(--accent)',
    dot: 'var(--accent-2)',
    since: 'с 12 мая',
    action: 'Отключить',
  },
  {
    phone: '+7 747 902 55 38',
    owner: 'Айгерим Сатпаева',
    dialogs: '390',
    status: 'Читается',
    statusFg: 'var(--accent)',
    dot: 'var(--accent-2)',
    since: 'с 3 июня',
    action: 'Отключить',
  },
  {
    phone: '+7 702 615 88 41',
    owner: 'Тимур Жаксылык',
    dialogs: '338',
    status: 'Сессия истекла',
    statusFg: 'var(--warn)',
    dot: 'var(--warn)',
    since: 'нужен новый QR',
    action: 'Обновить QR',
  },
];

/** Номер, который появляется в списке после успешной привязки по QR. */
export const whatsappPending = {
  phone: '+7 708 204 19 63',
  owner: 'Новый номер · ждёт имени продавца',
  dialogs: '0',
  status: 'Читается',
  statusFg: 'var(--accent)',
  dot: 'var(--accent-2)',
  since: 'подключён только что',
  action: 'Настроить',
};

export const whatsappSteps = [
  { n: '1', label: 'Откройте WhatsApp на телефоне продавца' },
  { n: '2', label: 'Настройки → Связанные устройства → Привязка устройства' },
  { n: '3', label: 'Наведите камеру на этот код' },
  {
    n: '4',
    label: 'Готово: новые переписки этого номера начнут разбираться автоматически',
  },
];
