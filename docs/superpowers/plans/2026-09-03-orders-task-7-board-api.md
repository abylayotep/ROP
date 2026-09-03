### Task 7: The board and the customers table

**Files:**
- Create: `server/src/api/board.ts`
- Modify: `server/src/api/server.ts` (register the routes)
- Modify: `packages/contract/index.ts` (the board and customer types)
- Create: `server/test/board-api.test.ts` (its contents are in [task-7-board-test.md](2026-09-03-orders-task-7-board-test.md))

**Interfaces:**
- Consumes: `requireAgent`, the tables `conversations`, `contacts`, `stages`, `orders`, `users`; `windowOpen` from `server/src/api/conversations.ts`.
- Produces: `registerBoardRoutes(app, db, guard)`, the exported `toCsv(rows)` helper, and:
  - `GET /api/agents/:agentId/board` → `Board`
  - `GET /api/agents/:agentId/customers` → `Customer[]`
  - `GET /api/agents/:agentId/customers.csv` → a CSV file

**Context.** Two read-only views over the same rows, asked different questions. The board asks "where is everyone in the funnel"; the customers table asks "who bought and who went quiet", which the board cannot answer because it is arranged by stage.

**One query, grouped in memory.** Every card needs its contact, its last line, its paid total and its assignee. One select with the joins and two correlated subqueries, then grouped by stage in JavaScript. A query per column would be one round trip per stage, and there are nine of them before the client adds any.

**The unsorted column.** Conversations with no stage go into `unsorted` rather than being hidden. A lead that arrived while nobody was looking is exactly the one that must not disappear.

- [ ] **Step 1: Extend the contract**

Append to `packages/contract/index.ts`:

```ts
/* ── Доска и клиенты ────────────────────────────────────────────────────────
 * The funnel seen as columns, and everyone who ever wrote seen as a table. */

export interface BoardCard {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  lastMessageAt: string | null;
  preview: string | null;
  /** Whether a free-form reply is still allowed. */
  windowOpen: boolean;
  adHeadline: string | null;
  /** The sum of this lead's paid orders, as a string with two decimals. */
  paidTotal: string;
  assigneeName: string | null;
}

export interface BoardColumn {
  stage: Stage;
  cards: BoardCard[];
}

export interface Board {
  columns: BoardColumn[];
  /** Conversations nobody has put in a stage yet. Shown first, never hidden. */
  unsorted: BoardCard[];
  currency: string;
}

export interface Customer {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  stageName: string | null;
  stageKind: StageKind | null;
  paidTotal: string;
  orderCount: number;
  lastMessageAt: string | null;
  firstSeenAt: string;
  assigneeName: string | null;
}
```

- [ ] **Step 2: Write the failing test**

The test is long enough to live in its own document:
[task-7-board-test.md](2026-09-03-orders-task-7-board-test.md). Create
`server/test/board-api.test.ts` with exactly the contents given there.

- [ ] **Step 3: Run it and watch it fail**

```bash
npm --prefix server test -- board-api
```

Expected: the file does not compile — `../src/api/board.js` does not exist.

- [ ] **Step 4: Write the routes**

Create `server/src/api/board.ts`:

```ts
import type { Board, BoardCard, Customer, Stage } from '@rakurs/contract';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { contacts, conversations, stages, users } from '../db/schema.js';
import { windowOpen } from './conversations.js';
import { requireAgent } from './require-agent.js';

/** A cell that would break the row is quoted, and a quote inside it is doubled. */
const cell = (value: string): string =>
  /[";\n\r]/.test(value) ? `"${value.split('"').join('""')}"` : value;

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
      paidTotal: sql<string>`coalesce((
        select sum(o.amount) from orders o
        where o.conversation_id = ${conversations.id} and o.status = 'paid'
      ), 0)::numeric(14,2)::text`,
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

type CardRow = Awaited<ReturnType<ReturnType<typeof selectCards>>>[number];

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
    const funnel = await db.select().from(stages).where(eq(stages.agentId, agentId));
    const byId = new Map(funnel.map((stage) => [stage.id, stage]));
    const rows = await selectCards(db, agentId);

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
```

- [ ] **Step 5: Register the routes**

In `server/src/api/server.ts`:

```ts
import { registerBoardRoutes } from './board.js';
```

```ts
  registerBoardRoutes(app, db, guard);
```

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add server/src/api/board.ts server/src/api/server.ts packages/contract/index.ts server/test/board-api.test.ts
git commit -m "Serve the funnel board and the customers table"
```
