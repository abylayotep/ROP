import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import * as kaspi from '@/api/kaspi';
import { humanError } from '@/api/client';
function formatCashierPhone(value: string) {
  let digits = value.replace(/\D/g, '');
  if (value.startsWith('+7') || (digits.length > 10 && /^[78]/.test(digits))) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  return '+7' + (digits ? ` (${digits.slice(0, 3)}` : '')
    + (digits.length > 3 ? `) ${digits.slice(3, 6)}` : '')
    + (digits.length > 6 ? `-${digits.slice(6, 8)}` : '')
    + (digits.length > 8 ? `-${digits.slice(8, 10)}` : '');
}

// Include adjacent punctuation when deleting a digit, so the mask cannot trap the cursor.
function handlePhoneDelete(event: KeyboardEvent<HTMLInputElement>) {
  const input = event.currentTarget;
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  if (start !== end || !['Backspace', 'Delete'].includes(event.key)) return;
  if (event.key === 'Backspace') {
    let position = start - 1;
    while (position >= 2 && /\D/.test(input.value[position])) position--;
    if (position < 2) { event.preventDefault(); return; }
    input.setSelectionRange(position, start);
  } else {
    let position = Math.max(start, 2);
    while (position < input.value.length && /\D/.test(input.value[position])) position++;
    input.setSelectionRange(Math.max(start, 2), position + 1);
  }
}

export function KaspiIntegration({ agentId, canManage = true }: { agentId: string; canManage?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<kaspi.KaspiStatus | null>(null);
  const [step, setStep] = useState<'idle' | 'phone' | 'otp'>('idle');
  const [phone, setPhone] = useState('+7');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void kaspi.getKaspiStatus(agentId).then(setStatus).catch((error) => setError(humanError(error))); }, [agentId]);
  function changePhone(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const raw = input.value;
    const beforeCursor = raw.slice(0, input.selectionStart ?? raw.length).replace(/\D/g, '').length;
    const formatted = formatCashierPhone(raw);
    setPhone(formatted);
    // Restore the position by digit count when editing in the middle of the number.
    requestAnimationFrame(() => {
      let position = 0;
      let count = 0;
      const target = beforeCursor + (raw.startsWith('+7') || raw.replace(/\D/g, '').length > 10 ? 0 : 1);
      while (position < formatted.length && count < target) {
        if (/\d/.test(formatted[position])) count++;
        position++;
      }
      input.setSelectionRange(Math.max(2, position), Math.max(2, position));
    });
  }
  async function act(action: () => Promise<void>) { setBusy(true); setError(null); try { await action(); } catch (error) { setError(humanError(error)); } finally { setBusy(false); } }
  return <section className="card card-pad" style={{ marginTop: 16 }}>
    <h3>Kaspi POS</h3>
    <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Счёт приходит клиенту в Kaspi по номеру телефона. QR — по запросу. Оплата подтверждается кассой.</p>
    {error && <p role="alert" style={{ color: 'var(--danger, #b42318)', maxWidth: 680 }}>{error}</p>}
    {!status ? <p>{error ? <button className="btn" onClick={() => void act(async () => setStatus(await kaspi.getKaspiStatus(agentId)))}>Повторить загрузку</button> : 'Загружаем…'}</p> : !status.configured ? <p>Подключение сервера Kaspi POS ещё не настроено.</p> : <>
      <p>{status.connected ? `Подключено: ${status.organization ?? status.phone ?? 'касса Kaspi'}` : 'Касса не подключена'}</p>
      {canManage && step === 'idle' && <button className="btn" disabled={busy} onClick={() => void act(async () => { setStep('phone'); })}>{status.connected ? 'Подключить заново' : 'Подключить кассу'}</button>}
      {step === 'phone' && <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await kaspi.initKaspi(agentId); await kaspi.sendKaspiPhone(agentId, phone); setStep('otp'); }); }}><label>Номер кассира <input className="input" type="tel" inputMode="tel" autoComplete="tel" required pattern="\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}" title="Введите номер полностью: +7 (777) 123-45-67" aria-label="Номер кассира" value={phone} onChange={changePhone} onKeyDown={handlePhoneDelete} placeholder="+7 (777) 123-45-67" /></label><button className="btn" disabled={busy}>{busy ? 'Запрашиваем SMS…' : 'Получить SMS'}</button></form>}
      {step === 'otp' && <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await kaspi.verifyKaspi(agentId, otp); setOtp(''); setStep('idle'); setStatus(await kaspi.getKaspiStatus(agentId)); }); }}><label>Код из SMS <input className="input" required aria-label="Код из SMS" value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></label><button className="btn" disabled={busy}>{busy ? 'Проверяем…' : 'Подтвердить'}</button></form>}
      {step !== 'idle' && <button className="btn-quiet" disabled={busy} onClick={() => { setStep('idle'); setOtp(''); setError(null); }}>Отмена</button>}
      {canManage && status.connected && step === 'idle' && <button className="btn-quiet" disabled={busy} onClick={() => void act(async () => { await kaspi.disconnectKaspi(agentId); setStatus(await kaspi.getKaspiStatus(agentId)); })}>Отключить</button>}
    </>}
  </section>;
}
