import { randomUUID } from 'node:crypto';
import type { WhatsappNumber } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
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

  const loadNumber = async (agentId: string, numberId: string) => {
    if (!isUuid(numberId)) throw new ApiError(404, 'Номер не найден');
    const [row] = await db
      .select()
      .from(whatsappNumbers)
      .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Номер не найден');
    return row;
  };

  app.post(
    '/api/agents/:agentId/whatsapp/linked',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<WhatsappNumber> => {
      const agentId = req.agent!.id;

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

      return streamPairing(reply, numberId);
    },
  );

  app.delete(
    '/api/agents/:agentId/whatsapp/linked/:numberId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { numberId } = req.params as { numberId: string };
      const number = await loadNumber(req.agent!.id, numberId);
      if (number.connectionKind !== 'linked') {
        throw new ApiError(400, 'Этот номер подключён не по QR.');
      }

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
  function streamPairing(reply: FastifyReply, numberId: string): Promise<void> {
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

      /**
       * Nobody is going to scan this pairing: the deadline passed, WhatsApp stopped issuing
       * codes, or the browser walked away. The row is removed rather than left in `pairing`,
       * where it would block every later attempt with «Подключение уже идёт» and show as a
       * number that does not work.
       */
      const abandon = (): Promise<void> =>
        db
          .delete(whatsappNumbers)
          .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.linkedState, 'pairing')))
          .catch(() => undefined)
          .then(() => linked.disconnect(numberId).catch(() => undefined))
          .then(() => undefined);

      const handler = (event: LinkedEvent): void => {
        if (event.numberId !== numberId) return;
        if (event.type === 'qr') send({ type: 'qr', qr: event.qr });
        if (event.type === 'open') finish({ type: 'open' });
        if (event.type === 'closed') {
          // WhatsApp hands out a finite list of codes and closes the socket once it has run
          // through them — about two and a half minutes in. Ignoring that leaves the last,
          // dead code on the owner's screen until the deadline, looking like a code that
          // simply stopped refreshing.
          const reason = event.loggedOut
            ? 'Телефон отказал в подключении.'
            : 'Код устарел. Нажмите «Подключить телефон по QR» ещё раз.';
          void abandon().finally(() => finish({ type: 'failed', reason }));
        }
      };

      const timer = setTimeout(() => {
        void abandon().finally(() =>
          finish({ type: 'failed', reason: 'Код никто не отсканировал. Попробуйте ещё раз.' }),
        );
      }, timeoutMs);
      timer.unref?.();

      unsubscribe = linked.on(handler);
      reply.raw.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          unsubscribe();
          // The tab is gone, so nobody can scan what is on it. Without this the row stays in
          // `pairing` for as long as the process lives, and every later attempt is refused.
          void abandon().finally(() => resolve());
        }
      });
    });
  }
}
