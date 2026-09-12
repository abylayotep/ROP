import { useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from '@/api/client';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/money';
import { formatPhone, phoneDigits } from '@/lib/phone';
import { useAgent } from '@/store/agent';
import { useVisibleRefresh } from './BoardScreen';
import './board.css';

export interface VerifiedOrder {
  id: string;
  conversationId: string;
  amount: string;
  currency: string;
  paidAt: string | null;
  contactName: string | null;
  contactPhone: string;
  comment: string | null;
  operationId: string | null;
}
interface OrdersResponse { orders: VerifiedOrder[] }

export function OrdersScreen() {
  const { agent } = useAgent();
  const [search, setSearch] = useState('');
  const orders = useApi<OrdersResponse>((signal) => request(`/agents/${agent.id}/orders`, { signal }), [agent.id]);
  useVisibleRefresh(orders);
  return <div className="funnel-screen">
    <div className="funnel-toolbar"><div><h2>Оплаченные заказы</h2><p>Покупки с подтверждённой оплатой через Kaspi.</p></div><Link className="btn" to="../funnel">Открыть воронку</Link></div>
    <Async state={orders} skeleton={<Skeleton height={320} />}>{(data) => {
      const query = search.trim().toLocaleLowerCase('ru');
      const digits = phoneDigits(query);
      const visible = data.orders.filter((order) => !query
        || (digits.length >= 4 && phoneDigits(order.contactPhone).includes(digits))
        || [order.contactName, order.comment, order.operationId].some((value) => value?.toLocaleLowerCase('ru').includes(query)));
      return <>
        <div className="funnel-controls"><label className="funnel-search"><span aria-hidden="true">⌕</span><input aria-label="Поиск оплаченных заказов" placeholder="Клиент, телефон, товар…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="funnel-total">Заказы: {search ? `${visible.length} из ${data.orders.length}` : data.orders.length}</span><span className="funnel-sync" role="status">{orders.loading ? 'Обновляем…' : 'Автообновление включено'}</span></div>
        {orders.error !== undefined && <div className="funnel-error" role="alert">Не удалось обновить заказы. Показаны последние данные. <button className="btn" onClick={orders.reload}>Повторить</button></div>}
        {!data.orders.length ? <EmptyState>Подтверждённых оплат пока нет. После подтверждения оплаты Kaspi заказ появится здесь автоматически.</EmptyState> : !visible.length ? <EmptyState>По этому запросу заказов нет.</EmptyState> : <div className="orders-table-wrap"><table className="orders-table"><thead><tr><th scope="col">Клиент</th><th scope="col">Товар / примечание</th><th scope="col">Сумма</th><th scope="col">Дата оплаты</th><th scope="col">Подтверждение</th></tr></thead><tbody>{visible.map((order) => <tr key={order.id}>
          <td><Link to={`../dialogs?conversation=${encodeURIComponent(order.conversationId)}`}>{formatPhone(order.contactPhone)}</Link></td>
          <td>{order.comment || '—'}</td><td style={{ whiteSpace: 'nowrap', fontWeight: 650 }}>{formatMoney(order.amount, order.currency)}</td><td style={{ whiteSpace: 'nowrap' }}>{order.paidAt ? new Date(order.paidAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td><td><span className="orders-verified">✓ Kaspi · оплачено</span>{order.operationId && <small>{order.operationId}</small>}</td>
        </tr>)}</tbody></table></div>}
      </>;
    }}</Async>
  </div>;
}
