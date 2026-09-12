import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Route, Routes } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VerifiedOrder } from './OrdersScreen';

const fixture = vi.hoisted(() => ({ orders: [] as VerifiedOrder[] }));
vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent' } }) }));
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ data: fixture, loading: false, error: undefined, reload: vi.fn() }) }));
import { OrdersScreen } from './OrdersScreen';
const render = () => renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/orders' }, createElement(Routes, null, createElement(Route, { path: '/a/:agentId' }, createElement(Route, { path: 'orders', element: createElement(OrdersScreen) })))));

describe('verified orders', () => {
  it('shows a provider-confirmed purchase and links back to its conversation', () => {
    fixture.orders = [{ id: 'order-1', conversationId: 'lead-1', amount: '12500.00', currency: 'KZT', paidAt: '2026-09-12T10:00:00Z', contactName: 'Анна', contactPhone: '+77012345678', comment: 'Курс английского', operationId: 'kaspi-42' }];
    const html = render();
    expect(html).toContain('href="/a/agent/dialogs?conversation=lead-1"');
    expect(html).toContain('Курс английского');
    expect(html).toContain('kaspi-42');
    expect(html).toContain('Kaspi · оплачено');
    expect(html).toContain('+7 701 234 56 78');
    expect(html).not.toContain('Анна');
  });
  it('explains why an empty paid-orders list has no manual payment button', () => {
    fixture.orders = [];
    const html = render();
    expect(html).toContain('Подтверждённых оплат пока нет');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('Добавить заказ');
  });
});
