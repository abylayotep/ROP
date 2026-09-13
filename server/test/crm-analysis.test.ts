import { describe, expect, it } from 'vitest';
import { crmPrompt, parseCrmAnalysis, resolveCrmStage, resolvePaymentEvidence } from '../src/lib/crm/analysis.js';

const messageId = '8a81e6fe-95f7-4f90-8314-e83830862921';
const history = [{ id: messageId, author: 'client', body: 'Меня зовут Айгуль. Алматы. Закажу два фильтра, отправьте счёт.' }];
const stages = [
  { id: 'new', name: 'Новый лид', kind: 'active', position: 0 },
  { id: 'ready', name: 'Готов к покупке', kind: 'active', position: 1 },
  { id: 'paid', name: 'Оплачено', kind: 'success', position: 2 },
];
const proof = (value: string) => ({ value, messageId, quote: value });
const output = (patch = {}) => JSON.stringify({ stageId: 'ready', summary: 'Заказал фильтры', confidence: 95,
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
    expect(resolveCrmStage(stages, 'paid', { paid: false, currentStageId: null })).toBeNull();
    expect(resolveCrmStage(stages, 'invented', { paid: false, currentStageId: null })).toBeNull();
    expect(resolveCrmStage(stages, 'ready', { paid: true, currentStageId: null })?.id).toBe('paid');
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

it('preserves classification and grounded fields when the model returns malformed optional evidence', () => {
  const result=parseCrmAnalysis(output({profile:{name:null,phone:'77010000000',city:proof('Алматы')},
    fields:{known:proof('Алматы'),broken:'Алматы'}}),history,[{id:'known',kind:'text'},{id:'broken',kind:'text'}]);
  expect(result.stageId).toBe('ready');
  expect(result.profile).toEqual({city:'Алматы'});
  expect(result.fields).toEqual({known:'Алматы'});
});

it('ignores malformed optional checkout without discarding a valid stage', () => {
  const result=parseCrmAnalysis(output({profile:[],fields:'unknown',checkout:{method:'qr'}}),history,[]);
  expect(result.stageId).toBe('ready');
  expect(result.profile).toEqual({});
  expect(result.fields).toEqual({});
  expect(result.checkout).toBeNull();
});

it('grounds unverified payment evidence without treating it as confirmation', () => {
  const result = parseCrmAnalysis(output({ payment: {
    state: 'needs_verification', messageId, quote: 'отправьте счёт', reason: 'Клиент сообщил об оплате',
  } }), history, []);
  expect(result.payment).toEqual({ state: 'needs_verification', reason: 'Клиент сообщил об оплате', messageId });
  expect(resolveCrmStage(stages, 'paid', { paid: false, currentStageId: null })).toBeNull();
});

it('rejects payment evidence quoted from seller instructions or an unknown message', () => {
  const seller = { id: 'seller', author: 'operator', body: 'Kaspi перевод +77066241022, Құралай А.' };
  const claimed = { state: 'needs_verification', messageId: seller.id, quote: 'Kaspi перевод', reason: 'Клиент оплатил' };
  expect(parseCrmAnalysis(output({ payment: claimed }), [seller], []).payment).toBeNull();
  expect(parseCrmAnalysis(output({ payment: { ...claimed, messageId: 'missing' } }), [seller], []).payment).toBeNull();
});

it('grounds a Kazakh customer payment claim while leaving confirmation to POS', () => {
  const client = { id: 'client-kz', author: 'client', body: 'Halyk арқылы аудардым, чекті кейін жіберемін.' };
  const result = parseCrmAnalysis(output({ payment: {
    state: 'needs_verification', messageId: client.id, quote: 'Halyk арқылы аудардым', reason: 'Клиент сообщил о переводе',
  } }), [client], []);
  expect(result.payment).toEqual({ state: 'needs_verification', messageId: client.id, reason: 'Клиент сообщил о переводе' });
  expect(resolveCrmStage(stages, 'paid', { paid: false, currentStageId: null })).toBeNull();
});

it('does not present attachment metadata as a read receipt', () => {
  const image = { id: 'image', author: 'client', kind: 'image', mediaMime: 'image/jpeg', body: null };
  const captioned = { ...image, id: 'captioned', body: 'Фото заказа, чек пришлю позже' };
  const evidence = (messageId: string) => ({ state: 'needs_verification', messageId,
    quote: 'На фото чек', reason: 'На фото чек с подтверждением оплаты' });
  expect(parseCrmAnalysis(output({ payment: evidence(image.id) }), [image], []).payment).toEqual({
    state: 'needs_verification', messageId: image.id, reason: 'Вложение требует проверки',
  });
  expect(parseCrmAnalysis(output({ payment: evidence(captioned.id) }), [captioned], []).payment).toEqual({
    state: 'needs_verification', messageId: captioned.id, reason: 'Вложение требует проверки',
  });
  expect(parseCrmAnalysis(output({ payment: evidence(image.id) }), [{ ...image, author: 'operator' }], []).payment).toBeNull();
});

it('treats an Instagram unsupported-attachment placeholder as metadata, not customer text', () => {
  const attachment = { id: 'instagram-image', author: 'client', kind: 'unsupported', mediaMime: null,
    body: 'Вложение Instagram пока не поддерживается.' };
  const claimed = { state: 'needs_verification', messageId: attachment.id,
    quote: attachment.body, reason: 'На фото оплаченный чек' };
  expect(parseCrmAnalysis(output({ payment: claimed }), [attachment], []).payment).toEqual({
    state: 'needs_verification', messageId: attachment.id, reason: 'Вложение требует проверки',
  });
  expect(parseCrmAnalysis(output({ payment: { ...claimed, state: 'awaiting_payment' } }), [attachment], []).payment).toBeNull();
});

it('describes prior analysis as revisable context and distinguishes attachment metadata', () => {
  const prompt = crmPrompt(stages, []);
  expect(prompt).toContain('previous analysis');
  expect(prompt).toContain('attachment metadata');
  expect(prompt).toContain('absence of a receipt does not prove nonpayment');
});

it('never retains a confirmed label without current provider confirmation', () => {
  expect(resolvePaymentEvidence('confirmed', 'old label', null, false)).toEqual({ state: 'unknown', reason: null });
  expect(resolvePaymentEvidence('needs_verification', 'Проверьте чек', null, false)).toEqual({ state: 'needs_verification', reason: 'Проверьте чек' });
  expect(resolvePaymentEvidence('unknown', null, null, true)).toEqual({ state: 'confirmed', reason: 'Оплата подтверждена Kaspi POS.' });
});

it('moves to the sale stage only on payment and never out of it', () => {
  const none = { paid: false, currentStageId: null };
  expect(resolveCrmStage(stages, 'paid', none)).toBeNull();
  expect(resolveCrmStage(stages, 'ready', none)?.id).toBe('ready');
  expect(resolveCrmStage(stages, 'ready', { paid: true, currentStageId: 'new' })?.id).toBe('paid');
  expect(resolveCrmStage(stages, 'new', { paid: false, currentStageId: 'paid' })).toBeNull();
});

it('accepts a client transfer claim as paid', () => {
  const client = { id: 'c1', author: 'client', kind: 'text', body: 'Добрый день, перевела 6990 на Kaspi' };
  const result = parseCrmAnalysis(output({ payment: { state: 'paid', messageId: 'c1', quote: 'перевела 6990', reason: 'Клиент перевёл оплату' } }), [client], []);
  expect(result.payment).toEqual({ state: 'paid', messageId: 'c1', reason: 'Клиент перевёл оплату' });
});

it('accepts a seller receipt confirmation as paid but not payment instructions', () => {
  const thanks = { id: 's1', author: 'phone', kind: 'text', body: 'Спасибо, оплату получили!' };
  const requisites = { id: 's2', author: 'operator', kind: 'text', body: 'Kaspi перевод +77066241022, Құралай А.' };
  const paid = (messageId: string, quote: string) => ({ payment: { state: 'paid', messageId, quote, reason: 'Продавец подтвердил' } });
  expect(parseCrmAnalysis(output(paid('s1', 'оплату получили')), [thanks], []).payment?.state).toBe('paid');
  expect(parseCrmAnalysis(output(paid('s2', 'Kaspi перевод')), [requisites], []).payment).toBeNull();
});

it('rejects paid on a negated claim and downgrades an attachment to verification', () => {
  const negated = { id: 'n1', author: 'client', kind: 'text', body: 'Ещё не оплатила, вечером' };
  expect(parseCrmAnalysis(output({ payment: { state: 'paid', messageId: 'n1', quote: 'не оплатила', reason: 'x' } }), [negated], []).payment).toBeNull();
  const photo = { id: 'p1', author: 'client', kind: 'image', mediaMime: 'image/jpeg', body: 'оплатила' };
  expect(parseCrmAnalysis(output({ payment: { state: 'paid', messageId: 'p1', quote: 'оплатила', reason: 'Чек' } }), [photo], []).payment)
    .toEqual({ state: 'needs_verification', messageId: 'p1', reason: 'Вложение требует проверки' });
});

it('grounds the paid amount in a seller price message', () => {
  const offer = { id: 'o1', author: 'phone', kind: 'text', body: 'Стандартный размер 40 мм — 6.990 тенге' };
  const client = { id: 'c1', author: 'client', kind: 'text', body: 'Беру за 6990' };
  const amount = (messageId: string, value: string, quote: string) => ({ paidAmount: { value, messageId, quote } });
  expect(parseCrmAnalysis(output(amount('o1', '6990', '6.990 тенге')), [offer, client], []).paidAmount).toBe('6990');
  expect(parseCrmAnalysis(output(amount('o1', '699', '6.990 тенге')), [offer, client], []).paidAmount).toBeNull();
  expect(parseCrmAnalysis(output(amount('c1', '6990', 'за 6990')), [offer, client], []).paidAmount).toBeNull();
  expect(parseCrmAnalysis(output(amount('o1', '6990', '7 000 тенге')), [offer, client], []).paidAmount).toBeNull();
  expect(parseCrmAnalysis(output(amount('o1', '1200000', '1 200 000')), [{ ...offer, body: 'Итого 1 200 000 ₸' }], []).paidAmount).toBe('1200000');
});

it('keeps paid evidence until Kaspi confirms or a new paid reason arrives', () => {
  expect(resolvePaymentEvidence('paid', 'Клиент перевёл', null, false)).toEqual({ state: 'paid', reason: 'Клиент перевёл' });
  expect(resolvePaymentEvidence('paid', 'Клиент перевёл', { state: 'unknown', reason: 'нет данных', messageId: 'm' }, false))
    .toEqual({ state: 'paid', reason: 'Клиент перевёл' });
  expect(resolvePaymentEvidence('paid', 'Клиент перевёл', null, true).state).toBe('confirmed');
});
