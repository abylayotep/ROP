import { useEffect, useState } from 'react';
import * as kaspi from '@/api/kaspi';
import { useToast } from '@/components/ui/Toast';
export function KaspiIntegration({ agentId, canManage = true }: { agentId: string; canManage?: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState<kaspi.KaspiStatus | null>(null);
  const [step, setStep] = useState<'idle' | 'phone' | 'otp'>('idle');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void kaspi.getKaspiStatus(agentId).then(setStatus).catch(toast.fail); }, [agentId]);
  async function act(action: () => Promise<void>) { setBusy(true); try { await action(); } catch (error) { toast.fail(error); } finally { setBusy(false); } }
  return <section className="card card-pad" style={{ marginTop: 16 }}>
    <h3>Kaspi POS</h3>
    <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Счёт приходит клиенту в Kaspi по номеру телефона. QR — по запросу. Оплата подтверждается кассой.</p>
    {!status ? <p>Загружаем…</p> : !status.configured ? <p>Подключение сервера Kaspi POS ещё не настроено.</p> : <>
      <p>{status.connected ? `Подключено: ${status.organization ?? status.phone ?? 'касса Kaspi'}` : 'Касса не подключена'}</p>
      {canManage && step === 'idle' && <button className="btn" disabled={busy} onClick={() => void act(async () => { await kaspi.initKaspi(agentId); setStep('phone'); })}>{status.connected ? 'Подключить заново' : 'Подключить кассу'}</button>}
      {step === 'phone' && <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await kaspi.sendKaspiPhone(agentId, phone); setStep('otp'); }); }}><label>Номер кассира <input aria-label="Номер кассира" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 701 123 45 67" /></label><button className="btn" disabled={busy}>Получить SMS</button></form>}
      {step === 'otp' && <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await kaspi.verifyKaspi(agentId, otp); setOtp(''); setStep('idle'); setStatus(await kaspi.getKaspiStatus(agentId)); }); }}><label>Код из SMS <input aria-label="Код из SMS" value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></label><button className="btn" disabled={busy}>Подтвердить</button></form>}
      {step !== 'idle' && <button className="btn-quiet" disabled={busy} onClick={() => { setStep('idle'); setOtp(''); }}>Отмена</button>}
      {canManage && status.connected && step === 'idle' && <button className="btn-quiet" disabled={busy} onClick={() => void act(async () => { await kaspi.disconnectKaspi(agentId); setStatus(await kaspi.getKaspiStatus(agentId)); })}>Отключить</button>}
    </>}
  </section>;
}
