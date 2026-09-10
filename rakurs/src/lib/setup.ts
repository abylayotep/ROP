/**
 * Готовность кабинета к работе: семь этапов запуска и что из них уже сделано.
 *
 * The state of a step is read from the cabinet's own data — a connected number, a stored
 * key, a knowledge record — and never from a checkbox somebody ticked. A checklist that
 * remembers being ticked would say «WhatsApp подключён» about an agent whose token expired
 * yesterday, and the owner would believe it right up until a customer wrote.
 *
 * Every step therefore has three answers rather than two. `done` is the whole step;
 * `partial` is the half-done state that looks finished from the outside and is exactly
 * where launches get stuck — a number Meta accepted but never subscribed, a model key
 * saved with the agent still switched off, a dataset connected with sending disabled.
 * `todo` is «ничего из этого ещё нет».
 */
import type { AiSettings, CapiSettings, WhatsappNumber } from '@/types';

export type SetupStepId =
  | 'whatsapp'
  | 'inbox'
  | 'funnel'
  | 'knowledge'
  | 'agent'
  | 'capi'
  | 'stats';

export type SetupState = 'done' | 'partial' | 'todo';

/** What the screen knows about the agent at the moment the checklist is drawn. */
export interface SetupFacts {
  numbers: WhatsappNumber[];
  /**
   * Сколько диалогов существует.
   *
   * A conversation is only ever created by an inbound message — the cabinet has no way to
   * start one — so a single conversation is proof that the webhook delivers, and zero is
   * proof that nothing has arrived yet.
   */
  conversations: number;
  stages: number;
  leadFields: number;
  knowledgeItems: number;
  ai: AiSettings;
  capi: CapiSettings;
}

export interface SetupStatus {
  state: SetupState;
  /** Одна строка о том, где этап стоит сейчас. Показывается рядом с заголовком. */
  note: string;
}

/**
 * Подключение номера.
 *
 * `subscribed: false` — это `partial`, а не `done`: Meta приняла номер, ответы из кабинета
 * уходят, а входящие никогда не придут. Снаружи это неотличимо от рабочего номера ровно
 * до первого клиента, поэтому чек-лист обязан назвать это вслух.
 */
export function whatsappStatus(numbers: WhatsappNumber[]): SetupStatus {
  if (numbers.length === 0) {
    return { state: 'todo', note: 'Ни одного номера не подключено' };
  }

  const unsubscribed = numbers.filter((number) => !number.subscribed);
  if (unsubscribed.length === numbers.length) {
    return {
      state: 'partial',
      note: 'Номер подключён, но приложение не подписано на WABA — входящие не придут',
    };
  }
  if (unsubscribed.length > 0) {
    return {
      state: 'partial',
      note: `Один из номеров не подписан на WABA: ${unsubscribed[0]!.displayPhone}`,
    };
  }

  const off = numbers.filter((number) => !number.enabled);
  if (off.length === numbers.length) {
    return {
      state: 'partial',
      note: 'Номер подключён, но выключен: сообщения принимаются, отправка не работает',
    };
  }

  return {
    state: 'done',
    note: numbers.length === 1 ? 'Номер подключён и работает' : `Номеров подключено: ${numbers.length}`,
  };
}

/** Первое сообщение от клиента: единственная проверка, что вебхук действительно доходит. */
export function inboxStatus(facts: Pick<SetupFacts, 'numbers' | 'conversations'>): SetupStatus {
  if (facts.numbers.length === 0) {
    return { state: 'todo', note: 'Сначала подключите номер' };
  }
  if (facts.conversations === 0) {
    return { state: 'todo', note: 'Ни одного диалога — напишите на номер с другого телефона' };
  }
  return { state: 'done', note: `Диалогов: ${facts.conversations}` };
}

/**
 * Воронка.
 *
 * Стадии и поля лида агенту создаются при создании, поэтому «не начато» здесь означает
 * поломку, а не первый день: у живого агента стадии есть всегда. Этап всё равно остаётся
 * в списке — его смысл в том, чтобы владелец один раз посмотрел на девять чужих стадий и
 * переименовал их под свою продажу.
 */
export function funnelStatus(facts: Pick<SetupFacts, 'stages' | 'leadFields'>): SetupStatus {
  if (facts.stages === 0) {
    return { state: 'todo', note: 'Стадий нет — доска будет пустой' };
  }
  if (facts.leadFields === 0) {
    return { state: 'partial', note: `Стадий ${facts.stages}, но полей лида нет` };
  }
  return { state: 'done', note: `Стадий ${facts.stages}, полей лида ${facts.leadFields}` };
}

/** База знаний: агенту нечем отвечать, пока в ней пусто. */
export function knowledgeStatus(items: number): SetupStatus {
  if (items === 0) return { state: 'todo', note: 'Ни одной заметки' };
  if (items < 5) {
    return { state: 'partial', note: `Заметок ${items} — на большинство вопросов ответить нечем` };
  }
  return { state: 'done', note: `Заметок ${items}` };
}

/**
 * ИИ-агент.
 *
 * Ключ без включённого агента — обычное и правильное состояние на день проверки в
 * песочнице, поэтому это `partial` с прямой подсказкой, а не «ошибка».
 */
export function agentStatus(facts: Pick<SetupFacts, 'ai' | 'knowledgeItems'>): SetupStatus {
  if (!facts.ai.keySet) return { state: 'todo', note: 'Ключ OpenRouter не сохранён' };
  if (!facts.ai.aiEnabled) {
    return { state: 'partial', note: 'Ключ есть, агент выключен — отвечают только люди' };
  }
  if (facts.knowledgeItems === 0) {
    return {
      state: 'partial',
      note: 'Агент включён, но база знаний пуста — он будет передавать диалоги человеку',
    };
  }
  return { state: 'done', note: 'Агент отвечает клиентам' };
}

/** Отправка покупок в Meta. Необязательный этап — без рекламы он не нужен вовсе. */
export function capiStatus(settings: CapiSettings): SetupStatus {
  if (settings.datasetId === '' || !settings.tokenSet) {
    return { state: 'todo', note: 'Набор данных не подключён' };
  }
  if (settings.error) return { state: 'partial', note: `Meta отказала: ${settings.error}` };
  if (!settings.enabled) {
    return { state: 'partial', note: 'Набор данных подключён, отправка выключена' };
  }
  return { state: 'done', note: 'Покупки уходят в Meta' };
}

/**
 * Статистика.
 *
 * Читать её осмысленно можно, только когда есть чему двигаться: диалоги и стадии. Этап
 * ничего не настраивает — он объясняет, с какого дня цифрам можно верить.
 */
export function statsStatus(facts: Pick<SetupFacts, 'conversations' | 'stages'>): SetupStatus {
  if (facts.conversations === 0) {
    return { state: 'todo', note: 'Считать пока нечего — диалогов нет' };
  }
  if (facts.stages === 0) return { state: 'todo', note: 'Без стадий воронки не будет' };
  return { state: 'done', note: 'Цифры собираются' };
}

export function setupStatuses(facts: SetupFacts): Record<SetupStepId, SetupStatus> {
  return {
    whatsapp: whatsappStatus(facts.numbers),
    inbox: inboxStatus(facts),
    funnel: funnelStatus(facts),
    knowledge: knowledgeStatus(facts.knowledgeItems),
    agent: agentStatus(facts),
    capi: capiStatus(facts.capi),
    stats: statsStatus(facts),
  };
}

/**
 * Сколько этапов пройдено.
 *
 * `partial` не засчитывается: половина подключённого номера — это ноль пришедших
 * сообщений, а не половина. Округлять её вверх значило бы печатать «6 из 7» кабинету,
 * который не работает.
 */
export function setupProgress(statuses: Record<SetupStepId, SetupStatus>): {
  done: number;
  total: number;
} {
  const all = Object.values(statuses);
  return { done: all.filter((status) => status.state === 'done').length, total: all.length };
}
