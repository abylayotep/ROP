### Task 10: The customers screen

**Files:**
- Modify: `rakurs/src/screens/CustomersScreen.tsx` (replace task 8's placeholder)

**Interfaces:**
- Consumes: `listCustomers` and `customersCsvUrl` from task 8, `formatMoney`, the contract type `Customer`.
- Produces: nothing other tasks read.

**Context.** The board is arranged by stage, so it cannot answer "who bought and who went quiet". This table can: one row per conversation, sortable, searchable, with a CSV the owner can hand to an accountant.

**Sorting and search happen in the browser.** The table holds one agent's conversations, which is hundreds, not millions. Paging it on the server would be a query parameter, an offset, and a spinner between pages, all to save an amount of data the board already fetches in one call.

**The export is a link, not a fetch.** `customers.csv` is authenticated by the same session cookie as everything else, so a plain anchor downloads it. Fetching it into memory to hand it back to the browser as a blob would be the same bytes twice.

- [ ] **Step 1: Write the screen**

Replace `rakurs/src/screens/CustomersScreen.tsx` with:

```tsx
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '@/api';
import { Card, CardHead } from '@/components/ui/primitives';
import { Async, EmptyState, RowsSkeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/money';
import { useAgent } from '@/store/agent';
import type { Customer } from '@/types';

type Sort = 'activity' | 'paid' | 'name';

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';

const cell = { padding: '11px 14px', fontSize: 12.5, verticalAlign: 'middle' } as const;

/** Строка поиска сравнивается и с именем, и с телефоном: ищут и так, и так. */
const matches = (customer: Customer, query: string) =>
  `${customer.contactName ?? ''} ${customer.contactPhone}`.toLowerCase().includes(query);

export function CustomersScreen() {
  const { agent } = useAgent();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('activity');

  const customers = useApi<Customer[]>((signal) => api.listCustomers(agent.id, signal), [agent.id]);

  const rows = useMemo(() => {
    const found = (customers.data ?? []).filter((customer) =>
      matches(customer, query.trim().toLowerCase()),
    );

    // Сортируем копию: useMemo не должен переставлять то, что пришло из useApi.
    return [...found].sort((a, b) => {
      if (sort === 'paid') return Number(b.paidTotal) - Number(a.paidTotal);
      if (sort === 'name') {
        return (a.contactName ?? a.contactPhone).localeCompare(b.contactName ?? b.contactPhone, 'ru');
      }
      // Без активности — вниз, а не наверх: пустая дата не «самая свежая».
      return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '');
    });
  }, [customers.data, query, sort]);

  return (
    <Card pad={false}>
      <div style={{ padding: '16px 18px 12px' }}>
        <CardHead
          title="Клиенты"
          gap={0}
          right={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={query}
                placeholder="Имя или телефон"
                onChange={(e) => setQuery(e.target.value)}
                style={{
                  padding: '7px 10px',
                  background: 'var(--sunken)',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  font: 'inherit',
                  fontSize: 12.5,
                  outline: 'none',
                }}
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                style={{
                  padding: '7px 10px',
                  background: 'var(--sunken)',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  font: 'inherit',
                  fontSize: 12.5,
                  outline: 'none',
                }}
              >
                <option value="activity">Сначала активные</option>
                <option value="paid">Сначала по сумме</option>
                <option value="name">По имени</option>
              </select>
              {/* Обычная ссылка: файл отдаёт сервер под той же сессионной кукой. */}
              <a className="btn-sm" href={api.customersCsvUrl(agent.id)}>
                Выгрузить CSV
              </a>
            </div>
          }
        />
      </div>

      <Async state={customers} skeleton={<RowsSkeleton rows={6} />}>
        {(all) =>
          all.length === 0 ? (
            <EmptyState>
              Клиентов пока нет. Они появятся, как только кто-нибудь напишет на подключённый
              номер.
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState>Никто не подошёл под «{query}».</EmptyState>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Клиент', 'Стадия', 'Оплачено', 'Заказов', 'Ответственный', 'Первое обращение', 'Активность'].map(
                    (title, index) => (
                      <th
                        key={title}
                        className="col-head"
                        style={{
                          padding: '8px 14px',
                          textAlign: index >= 2 && index <= 3 ? 'right' : 'left',
                        }}
                      >
                        {title}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((customer) => (
                  <tr
                    key={customer.conversationId}
                    className="row-hover"
                    style={{ borderTop: '1px solid var(--line-soft)', cursor: 'pointer' }}
                    onClick={() => navigate(`../dialogs?conversation=${customer.conversationId}`)}
                  >
                    <td style={cell}>
                      <div style={{ fontWeight: 600 }}>
                        {customer.contactName ?? customer.contactPhone}
                      </div>
                      {customer.contactName && (
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                          {customer.contactPhone}
                        </div>
                      )}
                    </td>
                    <td style={cell}>
                      {customer.stageName ?? (
                        <span style={{ color: 'var(--text-dim)' }}>Без стадии</span>
                      )}
                    </td>
                    <td className="mono" style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                      {customer.paidTotal === '0.00' ? (
                        <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>—</span>
                      ) : (
                        formatMoney(customer.paidTotal, agent.currency)
                      )}
                    </td>
                    <td className="mono" style={{ ...cell, textAlign: 'right' }}>
                      {customer.orderCount || '—'}
                    </td>
                    <td style={{ ...cell, color: 'var(--text-3)' }}>
                      {customer.assigneeName ?? '—'}
                    </td>
                    <td style={{ ...cell, color: 'var(--text-dim)' }}>{date(customer.firstSeenAt)}</td>
                    <td style={{ ...cell, color: 'var(--text-dim)' }}>{date(customer.lastMessageAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Async>
    </Card>
  );
}
```

- [ ] **Step 2: Check it compiles and builds**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

- [ ] **Step 3: Commit**

```bash
git add rakurs/src/screens/CustomersScreen.tsx
git commit -m "Add the customers table with a CSV export"
```
