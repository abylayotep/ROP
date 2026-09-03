import type { CSSProperties, ReactNode } from 'react';

/* ── Карточка ──────────────────────────────────────────────────────────────
 * Плоский стиль: теней нет вообще, разделение только границами. */

export function Card({
  children,
  pad = true,
  style,
  className = '',
}: {
  children: ReactNode;
  /** Внутренний отступ 18px 19px. Отключается, когда внутри таблица во всю ширину. */
  pad?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={`card ${pad ? 'card-pad' : ''} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

/** Заголовок карточки с подписью справа. */
export function CardHead({
  title,
  right,
  align = 'baseline',
  gap = 16,
}: {
  title: ReactNode;
  right?: ReactNode;
  align?: CSSProperties['alignItems'];
  gap?: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: align,
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: gap,
      }}
    >
      {typeof title === 'string' ? <h3 className="card-title">{title}</h3> : title}
      {right}
    </div>
  );
}

/* ── KPI ───────────────────────────────────────────────────────────────── */

export function Kpi({
  label,
  value,
  sub,
  color = 'var(--text)',
  size = 27,
  dot,
  variant = 'default',
  subLineHeight,
}: {
  label: string;
  value: string;
  sub: string;
  color?: string;
  /** 27 на обзоре, 25 на прочих экранах, 23 на рассылках. */
  size?: number;
  /** Точка-индикатор слева от значения — у «качества номера». */
  dot?: string;
  /**
   * На обзоре все три строки разделены ровным ритмом 8px, на остальных экранах
   * подпись прижата к значению чуть плотнее (8 сверху, 6 снизу). Разница
   * заметна только при сравнении экранов рядом, но она есть в макете.
   */
  variant?: 'overview' | 'default';
  /** У рассылок подпись длинная и задана с межстрочным 1.4. */
  subLineHeight?: number;
}) {
  const overview = variant === 'overview';

  const number = (
    <div
      className="mono"
      style={{
        fontSize: size,
        fontWeight: 700,
        letterSpacing: '-1px',
        whiteSpace: 'nowrap',
        color,
      }}
    >
      {value}
    </div>
  );

  return (
    <div
      className="card"
      style={{
        padding: '16px 17px',
        ...(overview ? { display: 'flex', flexDirection: 'column', gap: 8 } : null),
      }}
    >
      <div className="eyebrow" style={overview ? undefined : { marginBottom: 8 }}>
        {label}
      </div>
      {dot ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span
            style={{
              width: 9,
              height: 9,
              flex: '0 0 auto',
              borderRadius: '50%',
              background: dot,
            }}
          />
          {number}
        </div>
      ) : (
        number
      )}
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--text-muted)',
          ...(overview ? { lineHeight: 1.4 } : { marginTop: 6 }),
          ...(subLineHeight ? { lineHeight: subLineHeight } : null),
        }}
      >
        {sub}
      </div>
    </div>
  );
}

/* ── Сегмент-контрол ───────────────────────────────────────────────────── */

export interface SegmentItem<T extends string> {
  id: T;
  label: string;
  /** Счётчик справа от подписи — на уровнях таблицы креативов. */
  count?: string;
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  size = 'md',
  grow = false,
  padding: paddingOverride,
}: {
  items: SegmentItem<T>[];
  value: T;
  onChange: (id: T) => void;
  size?: 'sm' | 'md' | 'lg';
  /** Кнопки растягиваются на всю ширину — вкладки панели диалога. */
  grow?: boolean;
  /** Точечная правка отступов там, где в макете они отличаются от размера. */
  padding?: string;
}) {
  const padding =
    paddingOverride ?? (size === 'lg' ? '8px 14px' : size === 'sm' ? '6px 12px' : '5px 12px');
  const fontSize = size === 'lg' ? 12.5 : size === 'sm' ? 11.5 : 12;
  const radius = size === 'lg' ? 8 : 7;

  return (
    <div className={`seg ${size === 'lg' ? 'seg-lg' : ''}`.trim()}>
      {items.map((item) => {
        const on = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            style={{
              display: item.count ? 'flex' : undefined,
              alignItems: item.count ? 'center' : undefined,
              gap: item.count ? 7 : undefined,
              flex: grow ? 1 : undefined,
              padding,
              borderRadius: radius,
              fontSize,
              background: on ? 'var(--seg-on)' : 'transparent',
              color: on ? 'var(--text)' : 'var(--text-muted)',
            }}
          >
            <span>{item.label}</span>
            {item.count && (
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Бейджи и чипы ─────────────────────────────────────────────────────── */

export function Badge({
  children,
  bg,
  fg,
  size = 'md',
}: {
  children: ReactNode;
  bg: string;
  fg: string;
  /**
   * sm — категория шаблона рассылки, row — статус в строке таблицы диалогов,
   * md — статус в шапке панели и служебные бейджи, lg — вердикт креатива.
   */
  size?: 'sm' | 'row' | 'md' | 'lg';
}) {
  const map = {
    sm: { fontSize: 10.5, padding: '3px 8px', radius: 6 },
    row: { fontSize: 11, padding: '3px 8px', radius: 6 },
    md: { fontSize: 11, padding: '4px 9px', radius: 7 },
    lg: { fontSize: 11.5, padding: '6px 11px', radius: 8 },
  }[size];

  return (
    <span
      style={{
        fontSize: map.fontSize,
        fontWeight: 700,
        padding: map.padding,
        borderRadius: map.radius,
        background: bg,
        color: fg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/** Чип вложения в сообщении. */
export function AttachChip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        padding: '4px 8px',
        borderRadius: 6,
        background: 'var(--sunken-2)',
        border: '1px solid var(--line-strong)',
        color: 'var(--text-4)',
      }}
    >
      {children}
    </span>
  );
}

/** Чип отправленного материала в разборе диалога. */
export function SentChip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11.5,
        padding: '5px 10px',
        borderRadius: 7,
        background: 'var(--raise)',
        border: '1px solid var(--line-3)',
        color: 'var(--text-3)',
      }}
    >
      {children}
    </span>
  );
}

/* ── Полосы ────────────────────────────────────────────────────────────── */

export function Bar({
  width,
  fill,
  height = 5,
  track = 'var(--track)',
}: {
  width: string;
  fill: string;
  height?: number;
  track?: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 36,
        height,
        borderRadius: height,
        background: track,
        overflow: 'hidden',
      }}
    >
      <div style={{ height: '100%', borderRadius: height, background: fill, width }} />
    </div>
  );
}

export interface FunnelStep {
  label: string;
  value: string;
  pct: string;
  /**
   * Подсказка к доле. Нужна там, где на месте процента стоит прочерк: «делить не на
   * что» — это не ноль процентов, и без объяснения прочерк читается как поломка.
   */
  pctTitle?: string;
  w: string;
  fill: string;
}

/** Воронка. Крупный вариант — на обзоре, компактный — в разборе креатива. */
export function Funnel({ steps, compact = false }: { steps: FunnelStep[]; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 9 : 11 }}>
      {steps.map((f) => (
        <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: compact ? 12 : 14 }}>
          <div
            style={{
              width: compact ? 130 : 150,
              flex: `0 0 ${compact ? 130 : 150}px`,
              fontSize: compact ? 12 : 12.5,
              color: 'var(--text-3)',
            }}
          >
            {f.label}
          </div>
          <div
            style={{
              flex: 1,
              minWidth: compact ? 120 : 140,
              height: compact ? 22 : 28,
              borderRadius: compact ? 6 : 7,
              background: 'var(--raise)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                borderRadius: compact ? 6 : 7,
                background: f.fill,
                width: f.w,
              }}
            />
          </div>
          <div
            className="mono"
            style={{
              width: compact ? 52 : 96,
              flex: `0 0 ${compact ? 52 : 96}px`,
              textAlign: 'right',
              fontSize: compact ? 12.5 : 13,
              fontWeight: 700,
            }}
          >
            {f.value}
          </div>
          <div
            title={f.pctTitle}
            style={{
              width: compact ? 40 : 44,
              flex: `0 0 ${compact ? 40 : 44}px`,
              textAlign: 'right',
              fontSize: compact ? 11 : 11.5,
              color: 'var(--text-dim)',
            }}
          >
            {f.pct}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Мелочи ────────────────────────────────────────────────────────────── */

export function Avatar({ initials, size = 28 }: { initials: string; size?: number }) {
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, fontSize: size <= 24 ? 9.5 : size <= 28 ? 10.5 : 11.5 }}
    >
      {initials}
    </div>
  );
}

export function LiveDot({ size = 6, color = 'var(--accent-2)' }: { size?: number; color?: string }) {
  return (
    <span
      className="livedot"
      style={{ width: size, height: size, flex: '0 0 auto', background: color, display: 'block' }}
    />
  );
}

export function Dot({ size = 6, color }: { size?: number; color: string }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: '0 0 auto',
        borderRadius: '50%',
        background: color,
        display: 'block',
      }}
    />
  );
}

/** Тумблер. 28×16 в таблице креативов, 34×19 на экране агента. */
export function Toggle({ on, large = false }: { on: boolean; large?: boolean }) {
  const w = large ? 34 : 28;
  const h = large ? 19 : 16;
  const knob = large ? 15 : 12;
  return (
    <span
      style={{
        width: w,
        height: h,
        borderRadius: h,
        background: on ? 'var(--accent-2)' : 'var(--line-strong)',
        position: 'relative',
        display: 'block',
        flex: '0 0 auto',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? w - knob - 2 : 2,
          width: knob,
          height: knob,
          borderRadius: '50%',
          background: 'var(--text)',
        }}
      />
    </span>
  );
}

export function CheckBox({
  on,
  size = 16,
  danger = false,
}: {
  on: boolean;
  /** 16 в таблице креативов, 18 в списках аккаунтов и сегментов. */
  size?: number;
  /** Запрещённый сегмент рассылки отмечается красным. */
  danger?: boolean;
}) {
  const accent = danger ? 'var(--danger-2)' : 'var(--accent-2)';
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: '0 0 auto',
        borderRadius: size >= 18 ? 5 : 4,
        border: `1px solid ${on ? accent : 'var(--line-strong)'}`,
        background: on ? accent : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size >= 18 ? 11 : 10,
        fontWeight: 800,
        color: 'var(--on-accent)',
      }}
    >
      {on ? '✓' : ''}
    </div>
  );
}

/** Радио-кружок в карточках шаблона и темпа рассылки. */
export function RadioDot({ on, danger = false }: { on: boolean; danger?: boolean }) {
  const accent = danger ? 'var(--danger-2)' : 'var(--accent-2)';
  return (
    <div
      style={{
        width: 14,
        height: 14,
        flex: '0 0 auto',
        borderRadius: '50%',
        border: `1px solid ${on ? accent : 'var(--line-strong)'}`,
        background: on ? accent : 'transparent',
      }}
    />
  );
}

/** Строка статуса отправки события в Meta — под разборами. */
export function CapiLine({ color, title, meta }: { color: string; title: string; meta: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Dot color={color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
          {meta}
        </div>
      </div>
    </div>
  );
}

export function Divider({ margin = 0 }: { margin?: number | string }) {
  return <div style={{ height: 1, background: 'var(--line)', margin }} />;
}

/** Пара «ключ — значение» в столбик. */
export function KeyValue({
  k,
  v,
  vColor = 'var(--text)',
  vMono = false,
  kSize = 12,
  vSize = 12,
  vWeight = 600,
}: {
  k: string;
  v: string;
  vColor?: string;
  vMono?: boolean;
  kSize?: number;
  vSize?: number;
  vWeight?: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontSize: kSize, color: 'var(--text-muted)' }}>{k}</span>
      <span
        className={vMono ? 'mono' : undefined}
        style={{ fontSize: vSize, fontWeight: vWeight, textAlign: 'right', color: vColor }}
      >
        {v}
      </span>
    </div>
  );
}
