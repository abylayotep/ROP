import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { whatsappNumbers } from '../src/db/schema.js';
import { ApiError } from '../src/lib/errors.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { LinkedOffline } from '../src/lib/whatsapp/linked/client.js';
import { transportFor, TransportRefusal } from '../src/lib/whatsapp/transport.js';
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
    linkedJid: null,
    linkedState: null,
    createdAt: new Date(),
    ...over,
  } as Row;
}

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

    await transportFor(number(), { graph, linked, key }).sendText('77001234567', 'привет');

    expect(graph.calls.at(-1)).toMatchObject({
      method: 'sendText',
      args: ['136', 'EAAB-token', '77001234567', 'привет'],
    });
    expect(linked.calls).toHaveLength(0);
  });

  it('sends a coexistence number through Meta too', async () => {
    const graph = fakeGraph();

    await transportFor(number({ connectionKind: 'coexistence' }), {
      graph,
      linked: fakeLinked(),
      key,
    }).sendText('77001234567', 'привет');

    expect(graph.calls.at(-1)?.method).toBe('sendText');
  });

  it('sends a linked number through the socket, addressed by jid', async () => {
    const graph = fakeGraph();
    const linked = fakeLinked();
    linked.setOpen('n1', true);

    await transportFor(linkedRow(), { graph, linked, key }).sendText('77001234567', 'привет');

    expect(linked.calls.at(-1)).toMatchObject({
      method: 'sendText',
      args: ['n1', '77001234567@s.whatsapp.net', 'привет'],
    });
    expect(graph.calls).toHaveLength(0);
  });

  it('requires an open window for Meta and not for a linked device', () => {
    const deps = { graph: fakeGraph(), linked: fakeLinked(), key };

    expect(transportFor(number(), deps).requiresOpenWindow).toBe(true);
    expect(transportFor(number({ connectionKind: 'coexistence' }), deps).requiresOpenWindow).toBe(
      true,
    );
    expect(transportFor(linkedRow(), deps).requiresOpenWindow).toBe(false);
  });

  it('refuses a token the credentials key no longer opens', () => {
    expect(() =>
      transportFor(number({ accessToken: encryptSecret('EAAB-token', randomBytes(32), '136') }), {
        graph: fakeGraph(),
        linked: fakeLinked(),
        key,
      }),
    ).toThrow(TransportRefusal);
  });

  it('turns Meta saying no into a 502 an operator can read', async () => {
    const graph = fakeGraph({
      sendText: async () => {
        throw new GraphError('Recipient phone number not in allowed list', 400);
      },
    });

    const send = transportFor(number(), { graph, linked: fakeLinked(), key }).sendText(
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

    const failure = await transportFor(number(), { graph, linked: fakeLinked(), key })
      .sendText('77001234567', 'привет')
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(TransportRefusal);
    expect((failure as Error).message).not.toContain('EAAB-token');
  });

  it('tells an offline phone apart from an unlinked one', async () => {
    const deps = { graph: fakeGraph(), linked: fakeLinked(), key };

    const offline = transportFor(linkedRow(), deps).sendText('77001234567', 'привет');
    await expect(offline).rejects.toMatchObject({
      statusCode: 409,
      message: 'Телефон не на связи. Откройте WhatsApp на телефоне или подключите заново.',
    });

    const unlinked = transportFor(linkedRow({ linkedState: 'logged_out' }), deps).sendText(
      '77001234567',
      'привет',
    );
    await expect(unlinked).rejects.toMatchObject({
      statusCode: 409,
      message: 'Телефон отвязал кабинет. Нужно подключить заново по QR.',
    });
  });

  it('reports a refusal as an ApiError, so a route needs no translation', async () => {
    const send = transportFor(linkedRow(), {
      graph: fakeGraph(),
      linked: fakeLinked(),
      key,
    }).sendText('77001234567', 'привет');

    await expect(send).rejects.toBeInstanceOf(ApiError);
  });

  it('says plainly that Meta cannot take a file yet', () => {
    const transport = transportFor(number(), { graph: fakeGraph(), linked: fakeLinked(), key });

    expect(() => transport.sendMedia('77001234567', { path: '/tmp/a.jpg', mime: 'image/jpeg' })).toThrow(
      'Отправка файлов пока работает только для номера, подключённого по QR.',
    );
  });

  it('sends a file through a linked device', async () => {
    const linked = fakeLinked();
    linked.setOpen('n1', true);

    await transportFor(linkedRow(), { graph: fakeGraph(), linked, key }).sendMedia('77001234567', {
      path: '/tmp/a.jpg',
      mime: 'image/jpeg',
      caption: 'вот макет',
    });

    expect(linked.calls.at(-1)?.method).toBe('sendMedia');
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

    const send = transportFor(linkedRow(), { graph: fakeGraph(), linked, key }).sendText(
      '77001234567',
      'привет',
    );

    await expect(send).rejects.toThrow('websocket exploded');
    expect(LinkedOffline.name).toBe('LinkedOffline');
  });
});
