import { useEffect, useState } from 'react';
import {
  AttachChip,
  Badge,
  Bar,
  CapiLine,
  Divider,
  KeyValue,
  Segmented,
  SentChip,
} from '@/components/ui/primitives';
import { features } from '@/config';
import { useContextNavigation } from '@/lib/navigation';
import { scoreColor, statusStyle } from '@/lib/tone';
import { useAppState } from '@/store/app-state';
import type { Dialog } from '@/types';

/** Высота панели: экран минус шапка, фильтры и заголовок карточки. */
const PANEL_MAX_HEIGHT = 'calc(100vh - 320px)';

export function DialogPanel({ dialog }: { dialog: Dialog }) {
  const { state, set } = useAppState();
  const status = statusStyle(dialog.status);

  return (
    <div className="card" style={{ position: 'sticky', top: 20 }}>
      <div style={{ padding: '17px 18px 14px', borderBottom: '1px solid var(--line)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{dialog.client}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3 }}>
              {dialog.city} · {dialog.channel} · {dialog.time}
            </div>
          </div>
          <Badge bg={status.bg} fg={status.fg}>
            {dialog.status}
          </Badge>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 14,
            padding: '10px 12px',
            borderRadius: 9,
            background: 'var(--sunken)',
            border: '1px solid var(--line-2)',
          }}
        >
          <span className="eyebrow-sm" style={{ letterSpacing: '0.5px' }}>
            Оценка AI
          </span>
          <Bar width={`${dialog.score}%`} fill={scoreColor(dialog.score)} />
          <span
            className="mono"
            style={{ fontSize: 12.5, fontWeight: 700, color: scoreColor(dialog.score) }}
          >
            {dialog.score}
          </span>
        </div>

        <div style={{ marginTop: 12 }}>
          <Segmented
            grow
            padding="7px 10px"
            items={[
              { id: 'chat', label: `Переписка · ${dialog.chat.length}` },
              { id: 'analysis', label: 'Разбор AI' },
            ]}
            value={state.panel}
            onChange={(id) => set('panel', id)}
          />
        </div>
      </div>

      {state.panel === 'chat' ? <ChatTab dialog={dialog} /> : <AnalysisTab dialog={dialog} />}
    </div>
  );
}

function ChatTab({ dialog }: { dialog: Dialog }) {
  const sellerFirstName = dialog.seller.split(' ')[0];

  return (
    <div
      style={{
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxHeight: PANEL_MAX_HEIGHT,
        overflow: 'auto',
      }}
    >
      {dialog.chat.map((m, i) => {
        const mine = m.who === 'seller';
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              alignItems: mine ? 'flex-end' : 'flex-start',
            }}
          >
            {m.gap && (
              <div
                className="mono"
                style={{
                  alignSelf: 'center',
                  margin: '6px 0',
                  padding: '4px 11px',
                  borderRadius: 7,
                  background: 'rgba(216,87,76,0.1)',
                  border: '1px solid rgba(216,87,76,0.3)',
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: 'var(--danger)',
                }}
              >
                {m.gap}
              </div>
            )}
            <div
              style={{
                maxWidth: '90%',
                padding: '10px 12px',
                borderRadius: 12,
                background: mine ? 'rgba(13,150,104,0.1)' : 'var(--raise)',
                border: `1px solid ${mine ? 'rgba(13,150,104,0.3)' : 'var(--line-3)'}`,
              }}
            >
              <div
                className="pretty"
                style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)' }}
              >
                {m.text}
              </div>
              {m.attach && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                  {m.attach.map((a) => (
                    <AttachChip key={a}>{a}</AttachChip>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 3px' }}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                {m.time}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                {mine ? sellerFirstName : dialog.client}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AnalysisTab({ dialog }: { dialog: Dialog }) {
  const { openCreative } = useContextNavigation();
  const [copied, setCopied] = useState(false);

  // Сбрасываем подпись кнопки при переходе на другой диалог.
  useEffect(() => setCopied(false), [dialog.id]);

  const lost = dialog.status === 'Упустили';
  const work = dialog.status === 'В работе';

  const outcomeBg = lost
    ? 'rgba(216,87,76,0.08)'
    : work
      ? 'rgba(217,161,60,0.07)'
      : 'rgba(13,150,104,0.08)';
  const outcomeBd = lost
    ? 'rgba(216,87,76,0.28)'
    : work
      ? 'rgba(217,161,60,0.26)'
      : 'rgba(13,150,104,0.3)';
  const outcomeFg = lost ? 'var(--danger)' : work ? 'var(--warn)' : 'var(--accent)';
  const capiColor =
    dialog.capiTitle.includes('не отправлен') || lost
      ? 'var(--danger-2)'
      : work
        ? 'var(--warn)'
        : 'var(--accent-2)';

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(dialog.draft);
    } catch {
      // буфер недоступен (нет https или отказано в доступе) — подпись всё равно
      // меняем, чтобы кнопка не выглядела сломанной
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const sourceRows = [
    { k: 'Канал', v: dialog.channel },
    { k: 'Кампания', v: dialog.campaign },
    { k: 'Группа объявлений', v: dialog.group },
    { k: 'Креатив', v: dialog.creative },
    { k: 'Город', v: dialog.city },
  ];

  return (
    <div
      style={{
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 15,
        maxHeight: PANEL_MAX_HEIGHT,
        overflow: 'auto',
      }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            marginBottom: 9,
          }}
        >
          <div className="eyebrow-sm">Откуда пришёл</div>
          <button
            type="button"
            className="btn-link"
            style={{ fontSize: 11 }}
            onClick={() => openCreative(dialog.creative)}
          >
            Разбор креатива →
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {sourceRows.map((r) => (
            <KeyValue key={r.k} k={r.k} v={r.v} />
          ))}
        </div>
      </div>

      <Divider />

      <div>
        <div className="eyebrow-sm" style={{ marginBottom: 8 }}>
          Что спрашивал
        </div>
        <div className="pretty" style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)' }}>
          {dialog.ask}
        </div>
      </div>

      <div>
        <div className="eyebrow-sm" style={{ marginBottom: 8 }}>
          Что отправил продавец
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {dialog.sent.map((s) => (
            <SentChip key={s}>{s}</SentChip>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div className="eyebrow-sm" style={{ marginBottom: 7 }}>
            Для кого
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-2)' }}>
            {dialog.forWhom}
          </div>
        </div>
        <div>
          <div className="eyebrow-sm" style={{ marginBottom: 7 }}>
            Зачем
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-2)' }}>
            {dialog.purpose}
          </div>
        </div>
      </div>

      <Divider />

      <div
        style={{
          padding: '13px 14px',
          borderRadius: 11,
          background: outcomeBg,
          border: `1px solid ${outcomeBd}`,
        }}
      >
        <div className="eyebrow-sm" style={{ color: outcomeFg, marginBottom: 7 }}>
          {dialog.outcomeTitle}
        </div>
        <div className="pretty" style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)' }}>
          {dialog.outcome}
        </div>
      </div>

      {features.aiDrafts && (
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              marginBottom: 9,
            }}
          >
            <div className="eyebrow-sm">Что написать дальше</div>
            <button
              type="button"
              className="btn-sm"
              onClick={copyDraft}
              style={{ padding: '5px 10px' }}
            >
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
          </div>
          <div
            className="pretty"
            style={{
              fontSize: 12.5,
              lineHeight: 1.6,
              color: 'var(--text-2)',
              padding: '13px 14px',
              borderRadius: 11,
              background: 'var(--sunken)',
              border: '1px dashed var(--line-strong)',
            }}
          >
            {dialog.draft}
          </div>
          <div
            className="mono"
            style={{ marginTop: 8, fontSize: 10.5, color: 'var(--text-dim)' }}
          >
            {dialog.draftMeta}
          </div>
        </div>
      )}

      <Divider />

      <CapiLine color={capiColor} title={dialog.capiTitle} meta={dialog.capiMeta} />
    </div>
  );
}
