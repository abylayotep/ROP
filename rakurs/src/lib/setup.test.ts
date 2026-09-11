/**
 * Чек-лист запуска врёт ровно в одном месте — там, где половина работы выглядит целой.
 *
 * These cases are the half-done states: a number Meta accepted but never subscribed, a
 * model key saved with the agent still off, a dataset connected with sending disabled.
 * Each of them reads as «готово» from the outside, and each one means no customer is
 * being served. The counter is checked for the same reason: rounding a `partial` up would
 * print «6 из 7» over a cabinet that answers nobody.
 */
import { describe, expect, it } from 'vitest';
import type { AiSettings, CapiSettings, WhatsappNumber } from '@/types';
import {
  agentStatus,
  capiStatus,
  funnelStatus,
  inboxStatus,
  knowledgeStatus,
  setupProgress,
  whatsappGuideDone,
  whatsappSetupPath,
  whatsappStatus,
} from './setup';

const number = (over: Partial<WhatsappNumber> = {}): WhatsappNumber => ({
  id: 'n1',
  phoneNumberId: '100',
  wabaId: '200',
  displayPhone: '+7 700 000 00 00',
  enabled: true,
  subscribed: true,
  connectedAt: '2026-09-01T10:00:00.000Z',
  connectionKind: 'manual',
  linkedState: null,
  historyProgress: 0,
  historyDeclined: false,
  syncError: null,
  offboarded: false,
  tokenExpiresAt: null,
  ...over,
});

const ai = (over: Partial<AiSettings> = {}): AiSettings => ({
  aiEnabled: false,
  model: 'openai/gpt-4o-mini',
  temperature: 0.3,
  replyLanguage: 'auto',
  keySet: false,
  ...over,
});

const capi = (over: Partial<CapiSettings> = {}): CapiSettings => ({
  datasetId: '',
  testEventCode: null,
  enabled: false,
  tokenSet: false,
  verifiedAt: null,
  error: null,
  ...over,
});

describe('whatsappStatus', () => {
  it('не называет готовым номер, у которого истёк доступ Meta', () => {
    // Ровно тот случай, ради которого чек-лист читает данные, а не галочки: номер
    // подключён, подписан, включён — и не работает со вчерашнего дня.
    const status = whatsappStatus([
      number({ connectionKind: 'coexistence', tokenExpiresAt: '2026-09-10T09:00:00.000Z' }),
    ]);

    expect(status.state).toBe('partial');
    expect(status.note).toContain('Доступ Meta истёк');
  });

  it('не называет готовым номер, на который не придут сообщения', () => {
    // Meta приняла номер, кабинет им отвечает, входящих не будет никогда. Снаружи это
    // неотличимо от рабочего номера до первого клиента.
    const status = whatsappStatus([number({ subscribed: false })]);
    expect(status.state).toBe('partial');
    expect(status.note).toContain('WABA');
  });

  it('называет номер, который выпал из подписки, когда рядом есть рабочий', () => {
    const status = whatsappStatus([number(), number({ id: 'n2', subscribed: false, displayPhone: '+7 701 111 11 11' })]);
    expect(status.state).toBe('partial');
    expect(status.note).toContain('+7 701 111 11 11');
  });

  it('отличает выключенную отправку от неподключённого номера', () => {
    expect(whatsappStatus([number({ enabled: false })]).state).toBe('partial');
    expect(whatsappStatus([]).state).toBe('todo');
  });

  it('засчитывает подключённый и подписанный номер', () => {
    expect(whatsappStatus([number()]).state).toBe('done');
  });
});

describe('inboxStatus', () => {
  it('не требует проверки от кабинета, которому нечего проверять', () => {
    expect(inboxStatus({ numbers: [], conversations: 0 }).note).toContain('подключите номер');
  });

  it('считает один диалог доказательством, что вебхук доходит', () => {
    // Диалог заводится только входящим сообщением: начать переписку кабинет не умеет.
    expect(inboxStatus({ numbers: [number()], conversations: 0 }).state).toBe('todo');
    expect(inboxStatus({ numbers: [number()], conversations: 2 }).state).toBe('done');
  });
});

describe('funnelStatus и knowledgeStatus', () => {
  it('считает воронку готовой только вместе с полями лида', () => {
    expect(funnelStatus({ stages: 9, leadFields: 0 }).state).toBe('partial');
    expect(funnelStatus({ stages: 9, leadFields: 4 }).state).toBe('done');
    expect(funnelStatus({ stages: 0, leadFields: 4 }).state).toBe('todo');
  });

  it('не выдаёт одну заметку в базе знаний за наполненную базу', () => {
    expect(knowledgeStatus(0).state).toBe('todo');
    expect(knowledgeStatus(3).state).toBe('partial');
    expect(knowledgeStatus(12).state).toBe('done');
  });
});

describe('agentStatus', () => {
  it('называет ключ без включённого агента половиной работы, а не готовностью', () => {
    const status = agentStatus({ ai: ai({ keySet: true }), knowledgeItems: 20 });
    expect(status.state).toBe('partial');
    expect(status.note).toContain('выключен');
  });

  it('не считает готовым включённого агента с пустой базой знаний', () => {
    // Он включится и будет передавать каждый диалог человеку: цитировать нечего.
    expect(agentStatus({ ai: ai({ keySet: true, aiEnabled: true }), knowledgeItems: 0 }).state).toBe(
      'partial',
    );
    expect(agentStatus({ ai: ai({ keySet: true, aiEnabled: true }), knowledgeItems: 8 }).state).toBe(
      'done',
    );
  });
});

describe('capiStatus', () => {
  it('показывает отказ Meta вместо «подключено»', () => {
    const status = capiStatus(capi({ datasetId: '1', tokenSet: true, enabled: true, error: 'Invalid token' }));
    expect(status.state).toBe('partial');
    expect(status.note).toContain('Invalid token');
  });

  it('отличает выключенную отправку от неподключённого набора', () => {
    expect(capiStatus(capi({ datasetId: '1', tokenSet: true })).state).toBe('partial');
    expect(capiStatus(capi({ datasetId: '1', tokenSet: false })).state).toBe('todo');
    expect(capiStatus(capi({ datasetId: '1', tokenSet: true, enabled: true })).state).toBe('done');
  });
});

describe('setupProgress', () => {
  it('не округляет половину этапа вверх', () => {
    const progress = setupProgress({
      whatsapp: { state: 'done', note: '' },
      inbox: { state: 'partial', note: '' },
      funnel: { state: 'done', note: '' },
      knowledge: { state: 'partial', note: '' },
      agent: { state: 'todo', note: '' },
      capi: { state: 'todo', note: '' },
      stats: { state: 'done', note: '' },
    });
    expect(progress).toEqual({ done: 3, total: 7 });
  });
});

describe('whatsappStatus: номер по QR', () => {
  it('не обвиняет телефон по QR в неподписанной WABA — её у него нет', () => {
    const qr = number({ connectionKind: 'linked', subscribed: false, linkedState: 'open' });

    expect(whatsappStatus([qr])).toEqual({ state: 'done', note: 'Номер подключён и работает' });
  });

  it('держит этап наполовину, пока код не отсканирован', () => {
    const qr = number({ connectionKind: 'linked', subscribed: false, linkedState: 'pairing' });

    expect(whatsappStatus([qr]).state).toBe('partial');
  });

  it('говорит про отвязанный телефон вместо чужой ошибки про WABA', () => {
    const qr = number({ connectionKind: 'linked', subscribed: false, linkedState: 'logged_out' });

    expect(whatsappStatus([qr]).note).toContain('QR');
  });
});

describe('whatsappGuideDone', () => {
  it('не считает пройденным ничего, пока номера нет', () => {
    expect(whatsappGuideDone({ numbers: [], conversations: 0 }).size).toBe(0);
  });

  it('оставляет вебхук и живую проверку, пока не пришло ни одного сообщения', () => {
    const done = whatsappGuideDone({ numbers: [number()], conversations: 0 });

    // Шаги в Meta: адрес вебхука и подписка на messages отсюда не видны вовсе.
    expect(done.has(5)).toBe(false);
    expect(done.has(6)).toBe(false);
    expect(done.has(8)).toBe(false);
    expect(done.has(1)).toBe(true);
    expect(done.has(7)).toBe(true);
  });

  it('закрывает вебхук и проверку первым же входящим диалогом', () => {
    const done = whatsappGuideDone({ numbers: [number()], conversations: 1 });

    expect([5, 6, 8].every((step) => done.has(step))).toBe(true);
  });

  it('возвращает шаг о постоянном токене, когда доступ Meta истёк', () => {
    const expired = number({ tokenExpiresAt: '2020-01-01T00:00:00.000Z' });

    expect(whatsappGuideDone({ numbers: [expired], conversations: 0 }).has(4)).toBe(false);
  });
});

describe('whatsappSetupPath', () => {
  it('называет путь через Meta, пока все номера заведены вручную', () => {
    expect(whatsappSetupPath([number()])).toBe('meta');
  });

  it('называет номер с телефона, чтобы инструкции про Meta ему не показывали', () => {
    expect(whatsappSetupPath([number({ connectionKind: 'coexistence' })])).toBe('phone');
    expect(whatsappSetupPath([number({ connectionKind: 'linked' })])).toBe('phone');
  });

  it('не выбирает путь, пока номера нет', () => {
    expect(whatsappSetupPath([])).toBe('none');
  });
});
