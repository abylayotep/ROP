import type { WhatsappHistoryOverview, WhatsappHistoryRun } from '@rakurs/contract';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { whatsappNumbers } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import type { LinkedRegistry } from '../lib/whatsapp/linked/client.js';
import { createHistoryRequestManager, type HistoryTarget } from '../lib/whatsapp/linked/history-request.js';
import { requireAgent } from './require-agent.js';

const input = z.object({ limit: z.union([z.literal(100), z.literal(200)]) }).strict();

type TargetRow = {
  number_id: string;
  phone: string;
  message_id: string;
  from_me: boolean;
  sent_at: Date | string;
};

const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []);
};

async function loadTargets(db: Db, linked: LinkedRegistry, agentId: string, limit: 100 | 200) {
  const numberRows = await db.select({ id: whatsappNumbers.id }).from(whatsappNumbers).where(and(
    eq(whatsappNumbers.agentId, agentId), eq(whatsappNumbers.connectionKind, 'linked'),
    eq(whatsappNumbers.linkedState, 'open'), eq(whatsappNumbers.enabled, true),
  ));
  const openNumberIds = numberRows.filter((number) => linked.isOpen(number.id)).map((number) => number.id);
  if (openNumberIds.length === 0) return [];
  const openNumbers = sql.join(openNumberIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = rowsOf<TargetRow>(await db.execute(sql`
    select c.whatsapp_number_id as number_id, ct.phone,
           anchor.wa_message_id as message_id, (anchor.direction = 'out') as from_me,
           anchor.sent_at
      from conversations c
      join contacts ct on ct.id = c.contact_id and ct.agent_id = c.agent_id
      cross join lateral (
        select m.wa_message_id, m.direction, m.sent_at
          from messages m
         where m.conversation_id = c.id and m.wa_message_id is not null
         order by m.sent_at asc
         limit 1
      ) anchor
     where c.agent_id = ${agentId}
       and c.whatsapp_number_id in (${openNumbers})
       and ct.phone ~ '^[0-9]+$'
     order by c.last_message_at desc nulls last
     limit ${limit}
  `));

  return rows
    .map((row): HistoryTarget => {
      const jid = `${row.phone}@s.whatsapp.net`;
      return {
        numberId: row.number_id,
        jid,
        key: { id: row.message_id, remoteJid: jid, fromMe: row.from_me },
        timestamp: new Date(row.sent_at).getTime(),
      };
    });
}

export function registerWhatsappHistoryRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
  linked: LinkedRegistry,
  options: { timeoutMs?: number; paceMs?: number } = {},
): void {
  const member = requireAgent(db);
  const owner = requireAgent(db, { role: 'owner' });
  const manager = createHistoryRequestManager(linked, {
    loadTargets: (agentId, limit) => loadTargets(db, linked, agentId, limit),
    onDiagnostic: (report) => app.log.info({ historyRequest: report }, 'WhatsApp history request lifecycle'),
    ...options,
  });
  app.addHook('onClose', async () => manager.close());

  const overview = async (agentId: string): Promise<WhatsappHistoryOverview> => {
    const numbers = await db.select({ id: whatsappNumbers.id }).from(whatsappNumbers).where(and(
      eq(whatsappNumbers.agentId, agentId), eq(whatsappNumbers.connectionKind, 'linked'),
      eq(whatsappNumbers.linkedState, 'open'), eq(whatsappNumbers.enabled, true),
    ));
    return {
      connectedNumbers: numbers.filter((number) => linked.isOpen(number.id)).length,
      availableChats: (await loadTargets(db, linked, agentId, 200)).length,
      run: manager.get(agentId),
    };
  };

  app.get('/api/agents/:agentId/whatsapp/history', { preHandler: [guard, member] },
    async (req): Promise<WhatsappHistoryOverview> => overview(req.agent!.id));

  app.post('/api/agents/:agentId/whatsapp/history', { preHandler: [guard, owner] },
    async (req): Promise<WhatsappHistoryRun> => {
      const parsed = input.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Выберите 100 или 200 диалогов.');
      const current = manager.get(req.agent!.id);
      if (current && (current.status === 'requesting' || current.status === 'waiting')) return current;
      const status = await overview(req.agent!.id);
      if (status.connectedNumbers === 0) throw new ApiError(409, 'Подключённый номер WhatsApp сейчас недоступен.');
      if (status.availableChats === 0) {
        throw new ApiError(409, 'Первичная история ещё не получена. Пока нет известных чатов с сообщениями, по которым WhatsApp может продолжить загрузку.');
      }
      return manager.start(req.agent!.id, parsed.data.limit);
    });
}
