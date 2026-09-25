import { randomUUID } from 'node:crypto';
import type { QrPairingAvailability, WhatsappNumber } from '@rakurs/contract';
import { and, eq, like, notLike } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey } from '../lib/secret-box.js';
import { linkedAuthState } from '../lib/whatsapp/linked/auth-state.js';
import type { LinkedEvent, LinkedRegistry } from '../lib/whatsapp/linked/client.js';
import { isUuid } from '../lib/uuid.js';
import { toApi } from './whatsapp-numbers.js';
import { requireAgent } from './require-agent.js';

/**
 * Pairing a phone, and watching it happen.
 *
 * A QR code lives seconds and WhatsApp reissues it until somebody scans, so pairing is a
 * stream rather than a picture: the browser subscribes, the socket pushes, and the row
 * fills itself in when the phone answers.
 */

/**
 * The same deadline Embedded Signup's popup gets, for the same reason: a flow nobody
 * finished must not leave a half-created number in the list.
 */
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * A jid is required by the table's check constraint and does not exist until the phone
 * answers. This placeholder is what stands in until then — recognisable on sight, unique
 * per row, and replaced by the lifecycle the moment the socket opens.
 */
const pendingJid = (id: string): string => `pending:${id}`;

export interface LinkedRouteOptions {
  /** Injected by tests, which will not wait five minutes. */
  timeoutMs?: number;
}

export function registerWhatsappLinkedRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  linked: LinkedRegistry,
  options: LinkedRouteOptions = {},
): void {
  const ownerOnly = requireAgent(db, { role: 'owner' });
  const timeoutMs = options.timeoutMs ?? PAIRING_TIMEOUT_MS;

  /**
   * The deadline belongs to the server, not to the browser watching the QR code.
   *
   * It used to live inside the event stream, which meant a tab closed on a code — or one
   * that never subscribed at all — left the row in `pairing` for good: the socket kept
   * issuing codes nobody saw, and every later attempt by that account was refused with
   * «Подключение уже идёт» and nothing to click.
   */
  const deadlines = new Map<string, NodeJS.Timeout>();
  const reconnectStarts = new Map<string, Date>();
  const reconnecting = new Set<string>();
  app.addHook('onClose', async () => {
    for (const timer of deadlines.values()) clearTimeout(timer);
    deadlines.clear();
    reconnectStarts.clear();
  });

  const clearDeadline = (numberId: string): void => {
    const timer = deadlines.get(numberId);
    if (timer) clearTimeout(timer);
    deadlines.delete(numberId);
  };

  /** Idempotent: the stream and the deadline may both arrive at the same conclusion. */
  const cancelPairing = async (numberId: string, expectedStart?: Date): Promise<void> => {
    if (expectedStart && reconnectStarts.get(numberId) !== expectedStart) return;
    clearDeadline(numberId);
    await db.update(whatsappNumbers).set({ linkedState: 'logged_out', enabled: false })
      .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.linkedState, 'pairing'),
        notLike(whatsappNumbers.linkedJid, 'pending:%')));
    await db
      .delete(whatsappNumbers)
      .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.linkedState, 'pairing'),
        like(whatsappNumbers.linkedJid, 'pending:%')))
      .catch(() => undefined);
    await linked.disconnect(numberId).catch(() => undefined);
  };

  const armDeadline = (numberId: string): void => {
    clearDeadline(numberId);
    const startedAt = reconnectStarts.get(numberId);
    const timer = setTimeout(() => void cancelPairing(numberId, startedAt), timeoutMs);
    timer.unref?.();
    deadlines.set(numberId, timer);
  };

  // A pairing that settled has no deadline to keep: the phone answered, or WhatsApp
  // refused it and the lifecycle has already marked the row.
  linked.on((event) => {
    if (event.type === 'open' || (event.type === 'closed' && event.loggedOut)) {
      clearDeadline(event.numberId);
    }
  });

  const loadNumber = async (agentId: string, numberId: string) => {
    if (!isUuid(numberId)) throw new ApiError(404, 'Номер не найден');
    const [row] = await db
      .select()
      .from(whatsappNumbers)
      .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Номер не найден');
    return row;
  };

  app.get(
    '/api/agents/:agentId/whatsapp/qr-pairing',
    { preHandler: [guard, ownerOnly] },
    async (): Promise<QrPairingAvailability> => ({ enabled: env.WHATSAPP_QR_ENABLED }),
  );

  app.post(
    '/api/agents/:agentId/whatsapp/linked',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<WhatsappNumber> => {
      const agentId = req.agent!.id;
      // Hiding the card is not enough: the switch exists for when nobody may start one.
      if (!env.WHATSAPP_QR_ENABLED) throw new ApiError(403, 'Подключение по QR сейчас недоступно.');

      const [inFlight] = await db
        .select({ id: whatsappNumbers.id })
        .from(whatsappNumbers)
        .where(
          and(eq(whatsappNumbers.agentId, agentId), eq(whatsappNumbers.linkedState, 'pairing')),
        );
      if (inFlight) {
        throw new ApiError(409, 'Подключение уже идёт. Закройте его или дождитесь окончания.');
      }

      // The id is made here rather than by the database, because the row needs it inside
      // one of its own columns.
      const id = randomUUID();
      const [row] = await db
        .insert(whatsappNumbers)
        .values({
          id,
          agentId,
          // Both are filled by the lifecycle on `open`. Empty rather than invented: a
          // number nobody has scanned yet has no number to show.
          displayPhone: '',
          connectionKind: 'linked',
          linkedJid: pendingJid(id),
          linkedState: 'pairing',
        })
        .returning();

      // Started here, so the QR is already being issued by the time the browser subscribes.
      // A failure to even open a socket is the owner's to see, not a log line.
      try {
        await linked.connect(id);
        armDeadline(id);
      } catch (error) {
        await db.delete(whatsappNumbers).where(eq(whatsappNumbers.id, id));
        throw new ApiError(
          502,
          `Не удалось начать подключение: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return toApi(row!);
    },
  );

  app.get(
    '/api/agents/:agentId/whatsapp/linked/:numberId/qr',
    { preHandler: [guard, ownerOnly] },
    async (req, reply) => {
      const { numberId } = req.params as { numberId: string };
      const number = await loadNumber(req.agent!.id, numberId);
      if (number.connectionKind !== 'linked') throw new ApiError(404, 'Номер не найден');

      return streamPairing(reply, numberId, reconnectStarts.get(numberId) ?? number.createdAt);
    },
  );

  app.post('/api/agents/:agentId/whatsapp/linked/:numberId/reconnect',
    { preHandler: [guard, ownerOnly] }, async (req): Promise<WhatsappNumber> => {
      const { numberId } = req.params as { numberId: string };
      const number = await loadNumber(req.agent!.id, numberId);
      if (number.connectionKind !== 'linked' || number.linkedJid?.startsWith('pending:')) {
        throw new ApiError(400, 'Повторное подключение доступно для ранее привязанного телефона.');
      }
      if (reconnecting.has(numberId) || number.linkedState === 'pairing') {
        throw new ApiError(409, 'Подключение уже идёт. Дождитесь завершения.');
      }
      reconnecting.add(numberId);
      try {
        clearDeadline(numberId);
        await linked.logout(numberId).catch(() => undefined);
        await (await linkedAuthState(db, credentialsKey(env), numberId)).clear();
        const [row] = await db.update(whatsappNumbers)
          .set({ linkedState: 'pairing', enabled: true })
          .where(eq(whatsappNumbers.id, numberId)).returning();
        reconnectStarts.set(numberId, new Date());
        try {
          await linked.connect(numberId);
          armDeadline(numberId);
        } catch {
          await cancelPairing(numberId);
          throw new ApiError(502, 'Не удалось открыть QR. Переписки сохранены. Попробуйте ещё раз.');
        }
        return toApi(row!);
      } finally {
        reconnecting.delete(numberId);
      }
    });

  app.delete(
    '/api/agents/:agentId/whatsapp/linked/:numberId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { numberId } = req.params as { numberId: string };
      const number = await loadNumber(req.agent!.id, numberId);
      if (number.connectionKind !== 'linked') {
        throw new ApiError(400, 'Этот номер подключён не по QR.');
      }
      clearDeadline(numberId);

      // Best effort: the phone may already have dropped the pairing from its own side, and
      // that must not stop us forgetting it from ours.
      await linked.logout(numberId).catch(() => undefined);
      await (await linkedAuthState(db, credentialsKey(env), numberId)).clear();

      // The row stays, marked, and its conversations with it. Deleting the number would
      // cascade through every thread and every message it carried — the whole history of
      // the business's correspondence, thrown away to undo a pairing.
      await db
        .update(whatsappNumbers)
        .set({ linkedState: 'logged_out', enabled: false })
        .where(eq(whatsappNumbers.id, numberId));

      return { ok: true };
    },
  );

  /**
   * Server-sent events until the pairing settles.
   *
   * The handler unsubscribes on every exit — scanned, timed out, or the tab closed. A
   * handler left registered after the browser walked away outlives the pairing and keeps
   * a closed response alive to write into.
   */
  function streamPairing(reply: FastifyReply, numberId: string, startedAt: Date): Promise<void> {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Nginx buffers a response body by default, which for a stream means the browser
      // sees the first QR when the pairing is already over.
      'x-accel-buffering': 'no',
    });

    return new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const send = (payload: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const finish = (payload: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        reply.raw.end();
        resolve();
      };

      const handler = (event: LinkedEvent): void => {
        if (event.numberId !== numberId) return;
        if (event.type === 'qr') send({ type: 'qr', qr: event.qr });
        if (event.type === 'open') finish({ type: 'open' });
        // Only a logout ends a pairing. Every other close is expected and temporary: the
        // scan itself closes the socket — WhatsApp answers `pair-success` and then asks for
        // a restart — and so does running out of codes, which WhatsApp does about two and a
        // half minutes in. Both are the lifecycle's to reconnect, and the codes of the new
        // socket flow down this same stream. Treating them as failure is what made a
        // scanned code produce nothing at all.
        if (event.type === 'closed' && event.loggedOut) {
          finish({ type: 'failed', reason: 'Телефон отказал в подключении.' });
        }
      };

      // What is left of the pairing's own deadline, not a fresh one: a browser that
      // subscribes four minutes in must be told the code is dead in one, not in five.
      const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt.getTime()));
      const timer = setTimeout(() => {
        // Nobody scanned. The row is removed rather than left in `pairing`, where it would
        // block the next attempt and show as a number that does not work.
        void cancelPairing(numberId, reconnectStarts.has(numberId) ? startedAt : undefined).finally(() => {
          finish({ type: 'failed', reason: 'Код никто не отсканировал. Попробуйте ещё раз.' });
        });
      }, remaining);
      timer.unref?.();

      unsubscribe = linked.on(handler);
      reply.raw.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          unsubscribe();
          resolve();
        }
      });
    });
  }
}
