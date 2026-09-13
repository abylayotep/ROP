/**
 * The cabinet's sections, in menu order.
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
  /**
   * Hidden from anyone but the account's owner. `Sidebar` reads this to leave the item out
   * of the menu entirely, rather than showing a link into a screen whose every route —
   * the reads included — answers a non-owner with a 403.
   */
  ownerOnly?: boolean;
}

export const SECTIONS: SectionDef[] = [
  // Setup stays first; daily work starts in the funnel.
  { path: 'setup', label: 'Запуск', pending: '' },
  { path: 'funnel', label: 'Воронка', pending: '' },
  { path: 'orders', label: 'Заказы', pending: '' },
  { path: 'customers', label: 'Клиенты', pending: '' },
  { path: 'knowledge', label: 'База знаний', pending: '' },
  { path: 'coach', label: 'Обучение', pending: '', ownerOnly: true },
  { path: 'testing', label: 'Тестирование', pending: '', ownerOnly: true },
  { path: 'agent', label: 'Агент', pending: '' },
  {
    path: 'integrations',
    label: 'Интеграции',
    pending: '',
  },
  { path: 'stats', label: 'Статистика', pending: '' },
  { path: 'settings', label: 'Настройки', pending: '' },
];

export const sectionByPath = (path: string): SectionDef | undefined =>
  SECTIONS.find((section) => section.path === path);
