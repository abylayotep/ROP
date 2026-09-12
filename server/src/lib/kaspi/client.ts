import { ApiError } from '../errors.js';
export type KaspiSession = { tokenSN: string; vtokenSecret: string; profileId?: string };
export type ProviderReply = { StatusCode?: number; Message?: string; Data?: Record<string, unknown>; [key: string]: unknown };
export function normalisePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (!/^77\d{9}$/.test(digits)) throw new ApiError(400, 'Укажите казахстанский номер телефона');
  return digits;
}
export function validateAmount(raw: string): string {
  if (!/^\d{1,9}(?:\.0{1,2})?$/.test(raw) || Number(raw) < 1) throw new ApiError(400, 'Kaspi: сумма должна быть целым числом тенге от 1 до 999999999');
  return String(Number(raw));
}
export function operationId(reply: ProviderReply): string | null {
  const id = reply.Data?.QrOperationId ?? reply.Data?.Id ?? reply.Data?.OperationId;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}
export function paymentOutcome(reply: ProviderReply, amount: string): 'paid' | 'pending' | 'expired' | 'failed' {
  if (reply.StatusCode !== 0) return 'pending';
  const status = reply.Data?.Status;
  if (status === 'Processed') {
    const actual = reply.Data?.Amount;
    if (actual !== undefined && (!/^\d+(?:\.0{1,2})?$/.test(String(actual)) || Number(actual) !== Number(amount))) {
      throw new ApiError(502, 'Сумма подтверждения Kaspi не совпадает со счётом');
    }
    return 'paid';
  }
  if (status === 'Expired' || status === 'QrTokenDiscarded') return 'expired';
  if (['Cancelled', 'Rejected', 'Failed', 'CancelledByUser', 'Error', 'RemotePaymentCanceled', 'RemotePaymentRejected'].includes(String(status))) return 'failed';
  return 'pending';
}
export class KaspiClient {
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch) {}
  async request(method: string, path: string, body?: unknown, session?: KaspiSession): Promise<ProviderReply> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.url.replace(/\/$/, '')}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Token-SN': session.tokenSN, 'X-Vtoken-Secret': session.vtokenSecret, ...(session.profileId ? { 'X-Profile-Id': session.profileId } : {}) } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new ApiError(503, 'Kaspi недоступен. Результат запроса неизвестен'); }
    if (response.status === 401) throw new ApiError(409, 'Сессия Kaspi истекла. Подключите кассу заново');
    if (!response.ok) throw new ApiError(502, 'Kaspi отклонил запрос');
    let data: ProviderReply;
    try { data = await response.json() as ProviderReply; } catch { throw new ApiError(502, 'Некорректный ответ Kaspi'); }
    if (data.StatusCode === -101001) throw new ApiError(409, 'Сессия Kaspi истекла. Подключите кассу заново');
    return data;
  }
  create(method: 'invoice' | 'qr', session: KaspiSession, amount: string, phone: string, comment: string) {
    return this.request('POST', `/api/${method}/create`, { amount: Number(validateAmount(amount)), ...(method === 'invoice' ? { phoneNumber: normalisePhone(phone), comment } : {}) }, session);
  }
  status(method: string, session: KaspiSession, id: string) {
    return this.request('GET', method === 'invoice' ? `/api/invoice/details?operationId=${encodeURIComponent(id)}` : `/api/qr/status?qrOperationId=${encodeURIComponent(id)}`, undefined, session);
  }
}
