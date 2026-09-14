import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, linkedSessionKeys, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { linkedAuthState } from '../src/lib/whatsapp/linked/auth-state.js';
import {
  registerLinkedLifecycle,
  restoreLinkedSessions,
} from '../src/lib/whatsapp/linked/lifecycle.js';
import { createSendQueue } from '../src/lib/whatsapp/linked/queue.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { withDb } from './helpers/db.js';

/**
 * What happens to a number when its phone comes and goes.
 *
 * The distinction the whole file is about: a phone that is off is waited for, and a phone
 * that logged the cabinet out is not. Getting it the wrong way round either asks an owner
 * to re-pair over a flat battery, or keeps retrying a session WhatsApp has already thrown
 * away.
 */

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
const key = randomBytes(32);

/** Runs a scheduled reconnect immediately, and records how long it was meant to wait. */
function immediate() {
  const waits: number[] = [];
  return {
    waits,
    schedule: (run: () => void, ms: number) => {
      waits.push(ms);
      run();
    },
  };
}

async function seedNumber(over: Record<string, unknown> = {}): Promise<string> {
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      displayPhone: '+7 700 000 00 00',
      connectionKind: 'linked',
      linkedJid: 'pending:x',
      linkedState: 'open',
      ...over,
    })
    .returning();
  return number!.id;
}

const reload = async (id: string) =>
  (await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.id, id)))[0]!;

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Sealhouse' }).returning();
  agentId = agent!.id;
});

describe('send queue', () => {
  it('runs one send at a time, in order', async () => {
    const order: string[] = [];
    const queue = createSendQueue({ minGapMs: 0, jitterMs: 0, sleep: async () => undefined });

    await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        queue('n1', async () => {
          order.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 1));
          order.push(`${name}:end`);
        }),
      ),
    );

    expect(order).toEqual([
      'a:start', 'a:end',
      'b:start', 'b:end',
      'c:start', 'c:end',
    ]);
  });

  it('waits the gap before each send', async () => {
    const slept: number[] = [];
    const queue = createSendQueue({
      minGapMs: 1200,
      jitterMs: 0,
      sleep: async (ms) => void slept.push(ms),
      random: () => 0,
    });

    await queue('n1', async () => undefined);
    await queue('n1', async () => undefined);

    expect(slept).toEqual([1200, 1200]);
  });

  it('does not make one number wait for another', async () => {
    const done: string[] = [];
    const queue = createSendQueue({ minGapMs: 0, jitterMs: 0, sleep: async () => undefined });

    const slow = queue('n1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      done.push('n1');
    });
    const quick = queue('n2', async () => void done.push('n2'));

    await Promise.all([slow, quick]);
    expect(done).toEqual(['n2', 'n1']);
  });

  it('keeps going after a send fails', async () => {
    // A poisoned chain would reject every later message on that number with the first
    // one's error — a single refused send silencing a number for good.
    const queue = createSendQueue({ minGapMs: 0, jitterMs: 0, sleep: async () => undefined });

    await expect(
      queue('n1', async () => {
        throw new Error('no socket');
      }),
    ).rejects.toThrow('no socket');

    await expect(queue('n1', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('lifecycle', () => {
  it('writes the jid and the phone down when the pairing opens', async () => {
    const id = await seedNumber({ linkedState: 'pairing', displayPhone: '' });
    const client = fakeLinked();
    registerLinkedLifecycle(db, key, client, immediate());

    client.report({
      type: 'open',
      numberId: id,
      jid: '77085807932:12@s.whatsapp.net',
      displayPhone: '+77085807932',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(await reload(id)).toMatchObject({
      linkedState: 'open',
      linkedJid: '77085807932:12@s.whatsapp.net',
      displayPhone: '+77085807932',
    });
  });

  it('reconnects after a close that is not a logout', async () => {
    const id = await seedNumber();
    const client = fakeLinked();
    const timer = immediate();
    registerLinkedLifecycle(db, key, client, timer);

    client.report({ type: 'closed', numberId: id, loggedOut: false });
    await new Promise((r) => setTimeout(r, 20));

    expect(client.calls.filter((c) => c.method === 'connect')).toHaveLength(1);
    expect(timer.waits).toEqual([1000]);
    expect((await reload(id)).linkedState).toBe('open');
  });

  it('does not revive a number disabled while its reconnect timer was pending', async () => {
    const id = await seedNumber();
    const client = fakeLinked();
    let retry: (() => void) | undefined;
    registerLinkedLifecycle(db, key, client, { schedule: run => { retry = run; } });
    client.report({ type: 'closed', numberId: id, loggedOut: false });
    await db.update(whatsappNumbers).set({ enabled: false, linkedState: 'logged_out' }).where(eq(whatsappNumbers.id, id));
    retry?.();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(client.calls.filter(call => call.method === 'connect')).toHaveLength(0);
  });

  it('backs off further on every failure in a row', async () => {
    const id = await seedNumber();
    const client = fakeLinked();
    const timer = immediate();
    registerLinkedLifecycle(db, key, client, timer);

    for (let i = 0; i < 4; i += 1) {
      client.report({ type: 'closed', numberId: id, loggedOut: false });
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(timer.waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it('gives up after enough failures, without claiming the pairing is gone', async () => {
    const id = await seedNumber();
    const client = fakeLinked();
    const errors: string[] = [];
    registerLinkedLifecycle(db, key, client, { ...immediate(), onError: (m) => errors.push(m) });

    for (let i = 0; i < 14; i += 1) {
      client.report({ type: 'closed', numberId: id, loggedOut: false });
    }

    // Reconnects read the number asynchronously; wait for completion, not a wall-clock guess.
    await expect.poll(() => client.calls.filter((c) => c.method === 'connect').length).toBe(12);
    expect(errors.join(' ')).toContain('не отвечает');
    // Still `open`: WhatsApp never said the pairing was over, and telling the owner to
    // scan a new code because the phone was off would cost them the session they have.
    expect((await reload(id)).linkedState).toBe('open');
  });

  it('marks the number logged out and drops its session on a real logout', async () => {
    const id = await seedNumber();
    await (await linkedAuthState(db, key, id)).saveCreds();
    const client = fakeLinked();
    registerLinkedLifecycle(db, key, client, immediate());

    client.report({ type: 'closed', numberId: id, loggedOut: true });
    await new Promise((r) => setTimeout(r, 20));

    expect((await reload(id)).linkedState).toBe('logged_out');
    expect(
      await db
        .select()
        .from(linkedSessionKeys)
        .where(eq(linkedSessionKeys.whatsappNumberId, id)),
    ).toHaveLength(0);
    expect(client.calls.filter((c) => c.method === 'connect')).toHaveLength(0);
  });

  it('marks a blocked number banned and stops reconnecting, keeping its session', async () => {
    const id = await seedNumber();
    await (await linkedAuthState(db, key, id)).saveCreds();
    const client = fakeLinked();
    const errors: string[] = [];
    registerLinkedLifecycle(db, key, client, { ...immediate(), onError: (m) => errors.push(m) });

    client.report({ type: 'closed', numberId: id, loggedOut: false, statusCode: 403 });

    await expect.poll(async () => (await reload(id)).linkedState).toBe('banned');
    expect(client.calls.filter((c) => c.method === 'connect')).toHaveLength(0);
    expect(errors.join(' ')).toContain('403');
    expect(
      await db.select().from(linkedSessionKeys).where(eq(linkedSessionKeys.whatsappNumberId, id)),
    ).not.toHaveLength(0);
  });

  it('counts attempts again after the phone comes back', async () => {
    const id = await seedNumber();
    const client = fakeLinked();
    const timer = immediate();
    registerLinkedLifecycle(db, key, client, timer);

    client.report({ type: 'closed', numberId: id, loggedOut: false });
    await new Promise((r) => setTimeout(r, 5));
    client.report({ type: 'open', numberId: id, jid: 'x@s.whatsapp.net', displayPhone: '+7' });
    await new Promise((r) => setTimeout(r, 5));
    client.report({ type: 'closed', numberId: id, loggedOut: false });
    await new Promise((r) => setTimeout(r, 5));

    expect(timer.waits).toEqual([1000, 1000]);
  });
});

describe('restoreLinkedSessions', () => {
  it('connects every open linked number and nothing else', async () => {
    const open = await seedNumber();
    await seedNumber({ linkedState: 'logged_out' });
    await seedNumber({ enabled: false });
    await db.insert(whatsappNumbers).values({
      agentId,
      displayPhone: '+7 708 580 79 32',
      connectionKind: 'manual',
      phoneNumberId: '136',
      wabaId: '932',
      accessToken: 'encrypted',
    });
    const client = fakeLinked();

    await restoreLinkedSessions(db, client);

    expect(client.calls.filter((c) => c.method === 'connect')).toEqual([
      { method: 'connect', args: [open] },
    ]);
  });

  it('does not fail when one phone refuses to connect', async () => {
    const first = await seedNumber();
    const second = await seedNumber();
    const errors: string[] = [];
    const client = fakeLinked({
      connect: async (numberId: string) => {
        if (numberId === first) throw new Error('no network');
      },
    });

    await restoreLinkedSessions(db, client, (message) => errors.push(message));

    expect(client.calls.filter((c) => c.method === 'connect')).toHaveLength(2);
    expect(errors.join(' ')).toContain('no network');
    expect(second).toBeTruthy();
  });
});
