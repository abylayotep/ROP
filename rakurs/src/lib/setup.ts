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
import { tokenDeadline } from './whatsapp-token';

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

  // Телефон по QR живёт без Meta вовсе: у него нет WABA, которую можно было бы подписать,
  // и нет токена, которому истекать. Его половинчатые состояния — свои.
  const linked = numbers.filter((number) => number.connectionKind === 'linked');
  const waiting = linked.filter((number) => number.linkedState === 'pairing');
  if (waiting.length === numbers.length && waiting.length > 0) {
    return { state: 'partial', note: 'Код показан, телефон его ещё не отсканировал' };
  }
  const loggedOut = linked.filter((number) => number.linkedState === 'logged_out');
  if (loggedOut.length > 0) {
    return { state: 'partial', note: 'Телефон отвязал кабинет — подключите заново по QR' };
  }

  const unsubscribed = numbers.filter(
    (number) => number.connectionKind !== 'linked' && !number.subscribed,
  );
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

  // Написано в комментарии к этому файлу как пример вранья — и вот оно вслух: номер
  // подписан, включён, и с позавчера не ходит ни одно сообщение, потому что Meta
  // закончила шестидесятидневный токен.
  const dead = numbers.filter((number) => tokenDeadline(number).state === 'expired');
  if (dead.length > 0) {
    return {
      state: 'partial',
      note:
        dead.length === numbers.length
          ? 'Доступ Meta истёк — подключите номер заново через Meta'
          : `Доступ Meta истёк у номера ${dead[0]!.displayPhone} — подключите его заново`,
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

/**
 * Каким путём подключён номер.
 *
 * The guide in «Запуск» describes one of three paths — the manual Cloud API one, with a
 * separate SIM card and an application in Meta for Developers. An owner who connected the
 * phone they already sell from, by Embedded Signup or by QR, did none of that and never
 * will: showing them eight steps about System users and webhook fields reads as work they
 * forgot to do. So the path decides whether the instruction is shown at all, not just
 * which of its steps are finished.
 */
export type WhatsappSetupPath = 'none' | 'meta' | 'phone';

export function whatsappSetupPath(numbers: WhatsappNumber[]): WhatsappSetupPath {
  if (numbers.length === 0) return 'none';
  return numbers.every((number) => number.connectionKind === 'manual') ? 'meta' : 'phone';
}

/**
 * Какие шаги инструкции по WhatsApp кабинет уже видит пройденными.
 *
 * The guide is eight steps long, and for an owner whose number is already connected most of
 * it is work done last week: printing it again buries the step that is still undone. Only
 * what the cabinet can see counts — a number exists, its token still works, a message has
 * arrived. Nothing is inferred from the owner having read a step.
 *
 * Steps 5 and 6 — the webhook address and the `messages` field — happen entirely inside
 * Meta and are invisible from here, so the only proof that both are right is an inbound
 * message; until one arrives they stay in the list.
 */
export function whatsappGuideDone(
  facts: Pick<SetupFacts, 'numbers' | 'conversations'>,
): ReadonlySet<number> {
  const done = new Set<number>();
  if (facts.numbers.length === 0) return done;

  // Номер в кабинете — значит приложение Meta, SIM-карта, идентификаторы и форма
  // подключения уже позади: без каждого из этих шагов номера бы здесь не было.
  for (const step of [1, 2, 3, 7]) done.add(step);

  // Истёкший доступ Meta возвращает шаг о постоянном токене обратно в работу.
  if (!facts.numbers.some((number) => tokenDeadline(number).state === 'expired')) done.add(4);

  // Входящее сообщение — единственное доказательство, что вебхук прописан, поле messages
  // отмечено и живая проверка пройдена.
  if (facts.conversations > 0) for (const step of [5, 6, 8]) done.add(step);

  return done;
}
