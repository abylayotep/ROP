import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { whatsappNumbers } from '../src/db/schema.js';
import { ApiError } from '../src/lib/errors.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { LinkedOffline } from '../src/lib/whatsapp/linked/client.js';
import { transportFor, TransportRefusal, type TransportDeps } from '../src/lib/whatsapp/transport.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';

/**
 * Which way a message leaves, and what the caller is told when it cannot.
 *
 * The 24-hour window is the interesting one: it is Meta's rule, and the cabinet used to
 * enforce it for every number. On a linked device that refused sends WhatsApp would have
 * delivered, which reads to an operator as a policy rather than a bug.
 */

const key = randomBytes(32);
type Row = typeof whatsappNumbers.$inferSelect;

function number(over: Partial<Row> = {}): Row {
  return {
    id: 'n1',
    agentId: 'a1',
    phoneNumberId: '136',
    wabaId: '932',
    displayPhone: '+7 708 580 79 32',
    accessToken: encryptSecret('EAAB-token', key, '136'),
    enabled: true,
    subscribedAt: new Date(),
    connectionKind: 'manual',
    businessId: null,
    syncRequestedAt: null,
    syncError: null,
    historyProgress: 0,
    historyDeclinedAt: null,
    offboardedAt: null,
    tokenExpiresAt: null,
    linkedJid: null,
    linkedState: null,
    createdAt: new Date(),
    ...over,
  } as Row;
}

/**
 * Everything a transport is given, with the pieces a test does not care about filled in.
 *
 * `onTokenRejected` is required rather than optional on purpose: forgetting it at a call
 * site would mean a dead token is never written down, and the cabinet would keep showing
 * the number as working while every send failed.
 */
const deps = (over: Partial<TransportDeps> = {}): TransportDeps => ({
  graph: fakeGraph(),
  linked: fakeLinked(),
  key,
  onTokenRejected: async () => {},
  ...over,
});

const linkedRow = (over: Partial<Row> = {}): Row =>
  number({
    connectionKind: 'linked',
    phoneNumberId: null,
    wabaId: null,
    accessToken: null,
    linkedJid: '77085807932@s.whatsapp.net',
    linkedState: 'open',
    ...over,
  });

describe('transportFor', () => {
  it('sends a manual number through Meta, with its decrypted token', async () => {
    const graph = fakeGraph();
    const linked = fakeLinked();

    await transportFor(number(), deps({ graph, linked })).sendText('77001234567', 'привет');

    expect(graph.calls.at(-1)).toMatchObject({
      method: 'sendText',
      args: ['136', 'EAAB-token', '77001234567', 'привет'],
    });
    expect(linked.calls).toHaveLength(0);
  });

  it('sends a coexistence number through Meta too', async () => {
    const graph = fakeGraph();

    await transportFor(number({ connectionKind: 'coexistence' }), deps({ graph })).sendText(
      '77001234567',
      'привет',
    );

    expect(graph.calls.at(-1)?.method).toBe('sendText');
  });

  it('sends a linked number through the socket, addressed by jid', async () => {
    const graph = fakeGraph();
    const linked = fakeLinked();
    linked.setOpen('n1', true);

    await transportFor(linkedRow(), deps({ graph, linked })).sendText('77001234567', 'привет');

    expect(linked.calls.at(-1)).toMatchObject({
      method: 'sendText',
      args: ['n1', '77001234567@s.whatsapp.net', 'привет'],
    });
    expect(graph.calls).toHaveLength(0);
  });

  it('requires an open window for Meta and not for a linked device', () => {
    const shared = deps();

    expect(transportFor(number(), shared).requiresOpenWindow).toBe(true);
    expect(transportFor(number({ connectionKind: 'coexistence' }), shared).requiresOpenWindow).toBe(
      true,
    );
    expect(transportFor(linkedRow(), shared).requiresOpenWindow).toBe(false);
  });

  it('refuses a token the credentials key no longer opens', () => {
    expect(() =>
      transportFor(
        number({ accessToken: encryptSecret('EAAB-token', randomBytes(32), '136') }),
        deps(),
      ),
    ).toThrow(TransportRefusal);
  });

  it('turns Meta saying no into a 502 an operator can read', async () => {
    const graph = fakeGraph({
      sendText: async () => {
        throw new GraphError('Recipient phone number not in allowed list', 400);
      },
    });

    const send = transportFor(number(), deps({ graph })).sendText(
      '77001234567',
      'привет',
    );

    await expect(send).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('allowed list'),
    });
  });

  it('hides the token when quoting what Meta said', async () => {
    const graph = fakeGraph({
      sendText: async () => {
        throw new GraphError('Invalid OAuth token: EAAB-token', 401);
      },
    });

    const failure = await transportFor(number(), deps({ graph }))
      .sendText('77001234567', 'привет')
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(TransportRefusal);
    expect((failure as Error).message).not.toContain('EAAB-token');
  });

  it('tells an offline phone apart from an unlinked one', async () => {
    const shared = deps();

    const offline = transportFor(linkedRow(), shared).sendText('77001234567', 'привет');
    await expect(offline).rejects.toMatchObject({
      statusCode: 409,
      message: 'Телефон не на связи. Откройте WhatsApp на телефоне или подключите заново.',
    });

    const unlinked = transportFor(linkedRow({ linkedState: 'logged_out' }), shared).sendText(
      '77001234567',
      'привет',
    );
    await expect(unlinked).rejects.toMatchObject({
      statusCode: 409,
      message: 'Телефон отвязал кабинет. Нужно подключить заново по QR.',
    });
  });

  it('reports a refusal as an ApiError, so a route needs no translation', async () => {
    const send = transportFor(linkedRow(), deps()).sendText('77001234567', 'привет');

    await expect(send).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses media when an injected Graph client lacks media support', () => {
    const transport = transportFor(number(), deps());

    expect(() => transport.sendMedia('77001234567', { path: '/tmp/a.jpg', mime: 'image/jpeg' })).toThrow(
      'Отправка файлов через Meta недоступна.',
    );
  });

  it('sends a file through a linked device', async () => {
    const linked = fakeLinked();
    linked.setOpen('n1', true);

    await transportFor(linkedRow(), deps({ linked })).sendMedia('77001234567', {
      path: '/tmp/a.jpg',
      mime: 'image/jpeg',
      caption: 'вот макет',
    });

    expect(linked.calls.at(-1)?.method).toBe('sendMedia');
  });

  it('says the token has to be renewed when Meta refuses it as expired', async () => {
    // Code 190 is Meta's «this token is no longer valid». Quoting it verbatim leaves an
    // owner reading «Error validating access token» with nothing to do about it.
    const graph = fakeGraph({
      sendText: async () => {
        throw new GraphError('Error validating access token: Session has expired', 401, 190);
      },
    });

    const send = transportFor(number(), deps({ graph })).sendText('77001234567', 'привет');

    await expect(send).rejects.toMatchObject({
      statusCode: 409,
      message: 'Доступ Meta к номеру истёк. Подключите номер заново в интеграциях.',
    });
  });

  it('writes down that the token is dead when Meta refuses it', async () => {
    let marked = 0;
    const graph = fakeGraph({
      sendText: async () => {
        throw new GraphError('Error validating access token', 401, 190);
      },
    });

    await transportFor(number(), deps({ graph, onTokenRejected: async () => { marked += 1; } }))
      .sendText('77001234567', 'привет')
      .catch(() => undefined);

    expect(marked).toBe(1);
  });

  it('does not call a number dead because Meta refused for another reason', async () => {
    // The stated deadline is the cabinet's only promise about this number. Moving it on
    // any Graph failure would tell an owner to re-connect a number that works.
    let marked = 0;
    const graph = fakeGraph({
      sendText: async () => {
        throw new GraphError('Recipient phone number not in allowed list', 400, 131030);
      },
    });

    await transportFor(number(), deps({ graph, onTokenRejected: async () => { marked += 1; } }))
      .sendText('77001234567', 'привет')
      .catch(() => undefined);

    expect(marked).toBe(0);
  });

  it('still reports Meta\'s refusal when writing the dead token down fails', async () => {
    // The operator is waiting on an answer. A database that will not take the note is our
    // problem, not theirs, and it must not turn a clear refusal into a 500.
    const graph = fakeGraph({
      sendText: async () => {
        throw new GraphError('Error validating access token', 401, 190);
      },
    });

    const send = transportFor(
      number(),
      deps({
        graph,
        onTokenRejected: async () => {
          throw new Error('database is down');
        },
      }),
    ).sendText('77001234567', 'привет');

    await expect(send).rejects.toMatchObject({
      statusCode: 409,
      message: 'Доступ Meta к номеру истёк. Подключите номер заново в интеграциях.',
    });
  });

  it('lets an unexpected failure through untouched', async () => {
    // Only LinkedOffline means «nothing was attempted». Anything else is the library's own
    // failure, and dressing it as a refusal would tell the operator a story we cannot back.
    const linked = fakeLinked({
      sendText: async () => {
        throw new Error('websocket exploded');
      },
    });
    linked.setOpen('n1', true);

    const send = transportFor(linkedRow(), deps({ linked })).sendText(
      '77001234567',
      'привет',
    );

    await expect(send).rejects.toThrow('websocket exploded');
    expect(LinkedOffline.name).toBe('LinkedOffline');
  });

  it('bounds a linked send whose socket never settles promptly', async () => {
    const linked = fakeLinked({
      sendText: () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('late socket failure')), 30);
        }),
    });
    linked.setOpen('n1', true);

    const send = transportFor(linkedRow(), deps({ linked, linkedSendTimeoutMs: 5 })).sendText(
      '77001234567',
      'привет',
    );

    await expect(send).rejects.toMatchObject({
      statusCode: 504,
      message: 'Телефон не ответил вовремя. Результат отправки сообщения неизвестен.',
    });
  });
});


describe('Cloud media transport', () => {
  it('passes the local file and decrypted credentials to Graph', async () => {
    const sendMedia = vi.fn(async () => ({ messageId: 'wamid.MEDIA' }));
    const file = { path: '/tmp/qr.png', mime: 'image/png', caption: 'QR для оплаты' };
    const result = await transportFor(number(), deps({ graph: { ...fakeGraph(), sendMedia } })).sendMedia('77001234567', file);
    expect(result).toEqual({ messageId: 'wamid.MEDIA' });
    expect(sendMedia).toHaveBeenCalledWith('136', 'EAAB-token', '77001234567', file);
  });

  it('redacts a token echoed by the upload or send failure', async () => {
    const graph = { ...fakeGraph(), sendMedia: async () => { throw new GraphError('Rejected EAAB-token', 400); } };
    const result = transportFor(number(), deps({ graph })).sendMedia('77001234567', { path: '/tmp/qr.png', mime: 'image/png' });
    await expect(result).rejects.toMatchObject({ statusCode: 502, message: 'Meta не отправила сообщение: Rejected <токен скрыт>' });
  });

  it('records token rejection on media uploads as on text sends', async () => {
    const onTokenRejected = vi.fn(async () => {});
    const graph = { ...fakeGraph(), sendMedia: async () => { throw new GraphError('Expired token', 400, 190); } };
    await expect(transportFor(number(), deps({ graph, onTokenRejected })).sendMedia('77001234567', { path: '/tmp/qr.png', mime: 'image/png' })).rejects.toMatchObject({ statusCode: 409 });
    expect(onTokenRejected).toHaveBeenCalledOnce();
  });
});
