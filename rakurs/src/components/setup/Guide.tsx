/**
 * Кирпичи пошаговой инструкции: шаг, путь в чужом интерфейсе, значение с копированием.
 *
 * The guides are read by an owner who has never opened Meta for Developers, with the
 * cabinet in one window and Meta in the other. Three things decide whether that works:
 * a step is one action and says where it happens, a path through somebody else's menu is
 * spelled exactly as that menu spells it (in English, because Meta's interface is), and a
 * value that has to be pasted is copied by a button rather than retyped from a screenshot.
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/* ── Шаги ──────────────────────────────────────────────────────────────── */

export function Steps({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>;
}

/**
 * Один шаг: номер, заголовок-действие и объяснение под ним.
 *
 * The number is passed in rather than counted from the DOM, so a step can be quoted in
 * support («сделайте шаг 6») and keep the number the owner is looking at.
 */
export function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '11px 0', borderTop: '1px solid var(--line-soft)' }}>
      <div
        className="mono"
        style={{
          width: 22,
          height: 22,
          flex: '0 0 22px',
          borderRadius: '50%',
          border: '1px solid var(--line-strong)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--text-4)',
        }}
      >
        {n}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="pretty" style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.45 }}>
          {title}
        </div>
        {children && (
          <div
            className="pretty"
            style={{
              fontSize: 12,
              color: 'var(--text-4)',
              lineHeight: 1.55,
              marginTop: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/** Пункты внутри шага — «отметьте оба права», «заполните три поля». */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/* ── Путь в чужом меню ─────────────────────────────────────────────────── */

/**
 * Путь по меню Meta, написанный так, как он подписан там.
 *
 * Переводить его нельзя: в интерфейсе Meta нет пункта «Настройка API», и владелец,
 * который ищет перевод, не находит ничего.
 */
export function Path({ children }: { children: ReactNode }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 5,
        background: 'var(--sunken-2)',
        border: '1px solid var(--line-2)',
        color: 'var(--text-3)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/** Внешняя ссылка — всегда в новую вкладку: кабинет остаётся открытым рядом. */
export function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Ссылка на раздел кабинета того же агента. */
export function Inside({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to}>{children}</Link>;
}

/* ── Заметки ───────────────────────────────────────────────────────────── */

/**
 * Полоска с предупреждением.
 *
 * `warn` — то, что сломает подключение через сутки или через двести пятьдесят диалогов;
 * `danger` — то, что не отменить: привязку номера к WhatsApp Business Account Meta
 * второй раз не переиграет.
 */
export function Note({
  kind = 'plain',
  children,
}: {
  kind?: 'plain' | 'warn' | 'danger';
  children: ReactNode;
}) {
  const color =
    kind === 'warn' ? 'var(--warn)' : kind === 'danger' ? 'var(--danger)' : 'var(--text-muted)';
  const background =
    kind === 'warn' ? 'var(--warn-a07)' : kind === 'danger' ? 'var(--danger-a06)' : 'var(--sunken)';
  const border =
    kind === 'warn' ? 'var(--warn-a26)' : kind === 'danger' ? 'var(--danger-a16)' : 'var(--line-2)';

  return (
    <div
      className="pretty"
      style={{
        fontSize: 11.5,
        lineHeight: 1.55,
        color,
        background,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: '8px 10px',
      }}
    >
      {children}
    </div>
  );
}

/* ── Значение, которое надо вставить в Meta ────────────────────────────── */

/**
 * Значение с кнопкой копирования.
 *
 * Значение остаётся на экране целиком, а не прячется за кнопкой: `navigator.clipboard`
 * недоступен на странице, открытой не по HTTPS, и отказывает молча. Кнопка тогда пишет
 * «Не вышло — выделите вручную», и выделять есть что.
 */
export function Copy({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [said, setSaid] = useState<'' | 'ok' | 'fail'>('');

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setSaid('ok');
    } catch {
      setSaid('fail');
    }
    setTimeout(() => setSaid(''), 2500);
  }

  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 5 }}>
        <div
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '9px 11px',
            background: 'var(--sunken)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            fontSize: 11.5,
            color: 'var(--text-2)',
            overflowWrap: 'anywhere',
          }}
        >
          {value}
        </div>
        <button type="button" className="btn" style={{ flex: '0 0 auto' }} onClick={() => void copy()}>
          {said === 'ok' ? 'Скопировано' : said === 'fail' ? 'Выделите вручную' : 'Копировать'}
        </button>
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

/* ── Что бывает не так ─────────────────────────────────────────────────── */

export interface Trouble {
  /** Что видит владелец. */
  sign: string;
  /** Почему так и что с этим делать. */
  why: ReactNode;
}

/**
 * Разбор поломок по признаку, а не по причине.
 *
 * Владелец приходит сюда со словами «сообщения не приходят», а не «приложение не подписано
 * на WABA»: причину он как раз и ищет, значит искать он может только по признаку.
 */
export function Troubles({ items }: { items: Trouble[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
      {items.map((item) => (
        <div key={item.sign}>
          <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text-2)' }}>{item.sign}</div>
          <div
            className="pretty"
            style={{ fontSize: 11.5, color: 'var(--text-4)', lineHeight: 1.55, marginTop: 3 }}
          >
            {item.why}
          </div>
        </div>
      ))}
    </div>
  );
}
