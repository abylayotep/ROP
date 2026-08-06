import { useState, type CSSProperties, type FormEvent } from 'react';
import { humanError } from '@/api';
import { useAuth } from '@/store/auth';

const field: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  marginTop: 6,
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  outline: 'none',
};

const label: CSSProperties = { display: 'block', fontSize: 13, color: 'var(--text-3)' };

export function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      // При успехе компонент размонтируется — setBusy(false) намеренно нет.
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--page)',
        color: 'var(--text)',
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: 340,
          padding: 28,
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 12,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>Ракурс</div>
        <div style={{ marginTop: 4, marginBottom: 20, color: 'var(--text-muted)', fontSize: 13 }}>
          Войдите, чтобы открыть кабинет
        </div>

        <label style={label}>
          Почта
          <input
            style={field}
            type="email"
            value={email}
            autoComplete="username"
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label style={{ ...label, marginTop: 14 }}>
          Пароль
          <input
            style={field}
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <div role="alert" style={{ marginTop: 14, fontSize: 13, color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%',
            marginTop: 20,
            padding: '10px 12px',
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            border: 'none',
            borderRadius: 8,
            font: 'inherit',
            fontWeight: 600,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
