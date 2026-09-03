import type { Board, BoardCard, Customer, Stage } from '@rakurs/contract';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { contacts, conversations, stages, users } from '../db/schema.js';
import { windowOpen } from './conversations.js';
import { requireAgent } from './require-agent.js';

/**
 * One cell: defused against formula injection, then quoted if it would break the row.
 *
 * The leading apostrophe is the defence against **CSV formula injection**, and it is not a
 * stray character — do not delete it. `contactName` is the WhatsApp profile name, which the
 * *customer* writes, and this export is the only place in the product where text a stranger
 * controls is written into a file someone opens in another program. A lead who names
 * themselves `=HYPERLINK("http://evil","Click")` would otherwise arrive in the operator's
 * Excel as a live formula. Quoting alone does not stop it: Excel unquotes the cell first and
 * evaluates what is left. An apostrophe makes Excel treat the rest as text.
 *
 * `=`, `+`, `-` and `@` are the four characters Excel reads as "a formula starts here"; a
 * leading tab or carriage return is stripped before that test, so it hides one of the four.
 */
const cell = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[";\n\r]/.test(safe) ? `"${safe.split('"').join('""')}"` : safe;
};

/**
 * Rows to a CSV Excel can open.
 *
 * Semicolons, not commas: a Russian-locale Excel splits on the semicolon and would put a
 * whole comma-separated row into one cell. CRLF for the same reason.
 */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(cell).join(';')).join('\r\n');
}

/**
 * Every conversation of an agent with what both views need.
 *
 * One statement rather than one per column: the board has nine stages before a client adds
 * any, and a query per stage would be nine round trips to draw one screen.
 */
function selectCards(db: Db, agentId: string) {
  return db
    .select({
      id: conversations.id,
      stageId: conversations.stageId,
      lastInboundAt: conversations.lastInboundAt,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
      adHeadline: conversations.adHeadline,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      assigneeName: users.name,
      preview: sql<string | null>`(
        select m.body from messages m
        where m.conversation_id = ${conversations.id}
        order by m.sent_at desc
        limit 1
      )`,
      // Summed in Postgres and read back as a string: numeric never becomes a float here.
      //
      // The sum is cast wider than the column it sums. Each amount is numeric(14,2), so it
      // stops just under 10^12, but a handful of them add past that — and `::numeric(14,2)`
      // on the total would raise `numeric field overflow`, which fails the whole board or
      // customers request rather than one card. numeric(16,2) holds any sum of amounts this
      // table can store.
      paidTotal: sql<string>`coalesce((
        select sum(o.amount) from orders o
        where o.conversation_id = ${conversations.id} and o.status = 'paid'
      ), 0)::numeric(16,2)::text`,
      orderCount: sql<number>`(
        select count(*)::int from orders o where o.conversation_id = ${conversations.id}
      )`,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(users, eq(users.id, conversations.assignedTo))
    .where(eq(conversations.agentId, agentId))
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`);
}

// `selectCards` hands back the query builder itself, which is a thenable rather than a
// function: one `Awaited` on its return type is what unwraps the rows.
type CardRow = Awaited<ReturnType<typeof selectCards>>[number];

const toCard = (row: CardRow): BoardCard => ({
  conversationId: row.id,
  contactName: row.contactName,
  contactPhone: row.contactPhone,
  lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
  preview: row.preview,
  windowOpen: windowOpen(row.lastInboundAt),
  adHeadline: row.adHeadline,
  paidTotal: row.paidTotal,
  assigneeName: row.assigneeName,
});

const toStage = (row: typeof stages.$inferSelect): Stage => ({
  id: row.id,
  name: row.name,
  color: row.color,
  kind: row.kind as Stage['kind'],
  position: row.position,
  description: row.description,
  autoMessage: row.autoMessage,
});

export function registerBoardRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  const anyMember = requireAgent(db);

  app.get(
    '/api/agents/:agentId/board',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Board> => {
      const [funnel, rows] = await Promise.all([
        db
          .select()
          .from(stages)
          .where(eq(stages.agentId, req.agent!.id))
          .orderBy(asc(stages.position)),
        selectCards(db, req.agent!.id),
      ]);

      const byStage = new Map<string, BoardCard[]>(funnel.map((stage) => [stage.id, []]));
      const unsorted: BoardCard[] = [];
      for (const row of rows) {
        // A conversation whose stage was deleted lands here too, not nowhere: a lead that
        // arrived while nobody was looking is the one that must not disappear.
        const bucket = row.stageId ? byStage.get(row.stageId) : undefined;
        (bucket ?? unsorted).push(toCard(row));
      }

      return {
        columns: funnel.map((stage) => ({ stage: toStage(stage), cards: byStage.get(stage.id)! })),
        unsorted,
        currency: req.agent!.currency,
      };
    },
  );

  /** The same rows, asked "who bought and who went quiet" instead of "which column". */
  async function customers(agentId: string): Promise<Customer[]> {
    // Both statements at once, as the board route does: neither reads the other's result.
    const [funnel, rows] = await Promise.all([
      db.select().from(stages).where(eq(stages.agentId, agentId)),
      selectCards(db, agentId),
    ]);
    const byId = new Map(funnel.map((stage) => [stage.id, stage]));

    return rows.map((row) => {
      const stage = row.stageId ? byId.get(row.stageId) : undefined;
      return {
        conversationId: row.id,
        contactName: row.contactName,
        contactPhone: row.contactPhone,
        stageName: stage?.name ?? null,
        stageKind: (stage?.kind as Customer['stageKind']) ?? null,
        paidTotal: row.paidTotal,
        orderCount: row.orderCount,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        firstSeenAt: row.createdAt.toISOString(),
        assigneeName: row.assigneeName,
      };
    });
  }

  app.get(
    '/api/agents/:agentId/customers',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Customer[]> => customers(req.agent!.id),
  );

  app.get(
    '/api/agents/:agentId/customers.csv',
    { preHandler: [guard, anyMember] },
    async (req, reply) => {
      const rows = await customers(req.agent!.id);
      const date = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

      const csv = toCsv([
        ['Имя', 'Телефон', 'Стадия', 'Оплачено', 'Валюта', 'Заказов', 'Первое обращение', 'Последняя активность', 'Ответственный'],
        ...rows.map((row) => [
          row.contactName ?? '',
          row.contactPhone,
          row.stageName ?? '',
          row.paidTotal,
          req.agent!.currency,
          String(row.orderCount),
          date(row.firstSeenAt),
          date(row.lastMessageAt),
          row.assigneeName ?? '',
        ]),
      ]);

      // The byte order mark is what makes Excel read this as UTF-8 instead of the system
      // code page, which turns every Russian name into question marks.
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="customers.csv"')
        .send(`﻿${csv}`);
    },
  );
}
