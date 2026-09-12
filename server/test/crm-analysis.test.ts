import { describe, expect, it } from 'vitest';
import { parseCrmAnalysis, resolveCrmStage } from '../src/lib/crm/analysis.js';

const messageId = '8a81e6fe-95f7-4f90-8314-e83830862921';
const history = [{ id: messageId, author: 'client', body: 'Меня зовут Айгуль. Алматы. Закажу два фильтра, отправьте счёт.' }];
const stages = [
  { id: 'new', name: 'Новый лид', kind: 'active', position: 0 },
  { id: 'ordered', name: 'Заказано', kind: 'awaiting_payment', position: 1 },
  { id: 'paid', name: 'Оплачено', kind: 'success', position: 2 },
];
const proof = (value: string) => ({ value, messageId, quote: value });
const output = (patch = {}) => JSON.stringify({ stageId: 'ordered', summary: 'Заказал фильтры', confidence: 95,
  profile: { name: proof('Айгуль'), city: proof('Алматы') }, fields: {}, checkout: null, ...patch });

describe('CRM extraction evidence', () => {
  it('keeps grounded fields and discards invented values, evidence and identifiers', () => {
    const result = parseCrmAnalysis(output({ profile: {
      name: proof('Айгуль'), city: proof('Алматы'), address: proof('Москва'),
      product: { value: 'телевизор', messageId, quote: 'два фильтра' },
      phone: { value: '77010000000', messageId: 'unknown', quote: '77010000000' },
    }, fields: { known: proof('Алматы'), unknown: proof('Алматы') } }), history, [{ id: 'known', kind: 'text' }]);
    expect(result.profile).toEqual({ name: 'Айгуль', city: 'Алматы' });
    expect(result.fields).toEqual({ known: 'Алматы' });
  });
  it('does not treat a customer claim as paid or invent a stage', () => {
    expect(resolveCrmStage(stages, 'paid', false)?.id).toBe('ordered');
    expect(resolveCrmStage(stages, 'invented', false)).toBeNull();
    expect(resolveCrmStage(stages, 'ordered', true)?.id).toBe('paid');
  });
  it('rejects malformed model output instead of clearing customer fields', () => {
    expect(() => parseCrmAnalysis('not json', history, [])).toThrow();
  });
  it('requires a real quote and known client message for checkout intent', () => {
    const result = parseCrmAnalysis(output({ checkout: {
      method: 'qr', messageId, quote: 'пришлите QR', amount: '5000', amountMessageId: messageId,
    } }), history, []);
    expect(result.checkout).toBeNull();
  });
  it('accepts invoice only with explicit latest client request and seller amount evidence', () => {
    const sellerId = 'a8e8e37a-4dab-4dc1-9f75-e86c023f9478';
    const result = parseCrmAnalysis(output({ checkout: {
      method: 'invoice', messageId, quote: 'отправьте счёт', amount: '5000', amountMessageId: sellerId,
    } }), [{ id: sellerId, author: 'phone', body: 'Итого 5 000 ₸ за два фильтра' }, ...history], []);
    expect(result.checkout).toMatchObject({ method: 'invoice', amount: '5000', messageId });
  });
});

it('rejects refusal and non-price numbers even when a model extracts a positive substring', () => {
  const sellerId = 'seller';
  const refusal = [{id:sellerId,author:'phone',body:'Доставка за 2 дня. Мой телефон +77012345678'},
    {id:messageId,author:'client',body:'Не выставляйте счёт'}];
  const result = parseCrmAnalysis(output({profile:{phone:{value:'+77012345678',messageId:sellerId,quote:'+77012345678'}}, checkout:{
    method:'invoice',messageId,quote:'выставляйте счёт',amount:'2',amountMessageId:sellerId,
  }}),refusal,[]);
  expect(result.checkout).toBeNull();
  expect(result.profile.phone).toBeUndefined();
});
it('does not interpret a question about QR as authorization to create a payment', () => {
  const result = parseCrmAnalysis(output({checkout:{method:'qr',messageId,quote:'QR',amount:'5000',amountMessageId:'seller'}}),
    [{id:'seller',author:'operator',body:'Итого 5000 ₸'},{id:messageId,author:'client',body:'А что такое QR?'}],[]);
  expect(result.checkout).toBeNull();
});
