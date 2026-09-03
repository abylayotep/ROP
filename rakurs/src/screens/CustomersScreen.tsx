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

/** The query is matched against both the name and the phone: people search by either. */
const matches = (customer: Customer, query: string) =>
  `${customer.contactName ?? ''} ${customer.contactPhone}`.toLowerCase().includes(query);

export function CustomersScreen() {
  const { agent } = useAgent();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('activity');

  const customers = useApi<Customer[]>((signal) => api.listCustomers(agent.id, signal), [agent.id]);

  const open = (conversationId: string) => navigate(`../dialogs?conversation=${conversationId}`);

  const rows = useMemo(() => {
    const found = (customers.data ?? []).filter((customer) =>
      matches(customer, query.trim().toLowerCase()),
    );

    // Sort a copy: useMemo must not reorder what came out of useApi.
    return [...found].sort((a, b) => {
      if (sort === 'paid') return Number(b.paidTotal) - Number(a.paidTotal);
      if (sort === 'name') {
        return (a.contactName ?? a.contactPhone).localeCompare(b.contactName ?? b.contactPhone, 'ru');
      }
      // Compared as plain strings, not with localeCompare: these are ISO timestamps, where
      // byte order is time order, and a locale has no business deciding it. No activity goes
      // to the bottom rather than the top — a missing date is not «the freshest».
      const left = a.lastMessageAt ?? '';
      const right = b.lastMessageAt ?? '';
      return right < left ? -1 : right > left ? 1 : 0;
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
                type="search"
                aria-label="Поиск по имени или телефону"
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
              {/* A plain link: the server serves the file under the same session cookie. */}
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
            <EmptyState>Никто не подошёл под «{query.trim()}».</EmptyState>
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
                    // A table row is not focusable by itself, so without these the whole
                    // table is unreachable from the keyboard — and a list of customers is
                    // exactly what someone walks through without touching the mouse.
                    tabIndex={0}
                    role="link"
                    style={{ borderTop: '1px solid var(--line-soft)', cursor: 'pointer' }}
                    onClick={() => open(customer.conversationId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        open(customer.conversationId);
                      }
                    }}
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
