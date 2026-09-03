/**
 * The cabinet's eight sections, in menu order.
 *
 * One list feeds the routes, the sidebar and the header title, so a section cannot exist
 * in the menu without a route or gain a second name in the header.
 */

export interface SectionDef {
  /** Path segment under /a/:agentId/. */
  path: string;
  label: string;
  /** What is missing and when it arrives. Empty once the section is real. */
  pending: string;
}

export const SECTIONS: SectionDef[] = [
  { path: 'orders', label: 'Заказы', pending: '' },
  {
    path: 'dialogs',
    label: 'Диалоги',
    pending: '',
  },
  { path: 'customers', label: 'Клиенты', pending: '' },
  {
    path: 'knowledge',
    label: 'База знаний',
    pending: 'Загрузка документов и карточки товаров появятся на этапе 4.',
  },
  {
    path: 'agent',
    label: 'Агент',
    pending: 'Скрипт продаж, выбор модели и правила появятся на этапе 5.',
  },
  {
    path: 'integrations',
    label: 'Интеграции',
    pending: '',
  },
  {
    path: 'stats',
    label: 'Статистика',
    pending: 'Воронка, конверсия и источники лидов появятся на этапе 7.',
  },
  { path: 'settings', label: 'Настройки', pending: '' },
];

export const sectionByPath = (path: string): SectionDef | undefined =>
  SECTIONS.find((section) => section.path === path);
