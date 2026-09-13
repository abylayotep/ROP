import { Fragment, useEffect, type CSSProperties, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  EFFECTIVE_DATE,
  LEGAL_DOCUMENTS,
  LEGAL_PAGE_IDS,
  LEGAL_UI,
  legalLang,
  legalPath,
  type LegalBlock,
  type LegalLang,
  type LegalPageId,
} from './content';

const SUPPORT_BOT = '@tasbaqa_helper_bot';
const SUPPORT_BOT_URL = 'https://t.me/tasbaqa_helper_bot';

/** URLs and the support bot handle; trailing punctuation is trimmed off a URL below. */
const LINKABLE = /(https?:\/\/[^\s()]+|@tasbaqa_helper_bot)/g;

/** Turns plain content text into text with links, so the content modules stay markup-free. */
export function linkify(text: string): ReactNode[] {
  return text.split(LINKABLE).map((part, index) => {
    if (index % 2 === 0) return part;
    if (part === SUPPORT_BOT) {
      return <a key={index} href={SUPPORT_BOT_URL} target="_blank" rel="noreferrer">{part}</a>;
    }
    const url = part.replace(/[.,;:]+$/, '');
    const tail = part.slice(url.length);
    return (
      <Fragment key={index}>
        <a href={url}>{url.replace(/^https?:\/\//, '')}</a>
        {tail}
      </Fragment>
    );
  });
}

const page: CSSProperties = {
  minHeight: '100vh',
  background: 'var(--page)',
  color: 'var(--text)',
  padding: '32px 20px 64px',
};

const column: CSSProperties = { maxWidth: 760, margin: '0 auto', lineHeight: 1.65, fontSize: 15 };

const muted: CSSProperties = { color: 'var(--text-muted)', fontSize: 13 };

export function LegalPage({ id }: { id: LegalPageId }) {
  const [search] = useSearchParams();
  const lang = legalLang(search);
  const doc = LEGAL_DOCUMENTS[id][lang];
  const ui = LEGAL_UI[lang];

  useEffect(() => {
    const previous = document.title;
    document.title = `${doc.title} — ${ui.back}`;
    return () => {
      document.title = previous;
    };
  }, [doc.title, ui.back]);

  return (
    <div style={page} lang={lang}>
      <div style={column}>
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            paddingBottom: 16,
            borderBottom: '1px solid var(--line)',
          }}
        >
          <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 13.5 }}>
            <Link to="/" style={{ color: 'var(--text)', fontWeight: 650 }}>{ui.back}</Link>
            {LEGAL_PAGE_IDS.map((other) => (
              <Link
                key={other}
                to={legalPath(other, lang)}
                aria-current={other === id ? 'page' : undefined}
                style={other === id ? { color: 'var(--text-3)' } : undefined}
              >
                {ui.nav[other]}
              </Link>
            ))}
          </nav>
          <LangSwitch id={id} lang={lang} />
        </header>

        <h1 style={{ fontSize: 28, lineHeight: 1.25, margin: '28px 0 6px', fontWeight: 700 }}>{doc.title}</h1>
        <div style={muted}>
          {ui.effective}: {EFFECTIVE_DATE[lang]}
        </div>

        {doc.intro.map((text) => (
          <p key={text} style={{ margin: '18px 0 0', color: 'var(--text-2)' }}>{linkify(text)}</p>
        ))}

        {doc.sections.map((section) => (
          <section key={section.heading} style={{ marginTop: 30 }}>
            <h2 style={{ fontSize: 18, lineHeight: 1.35, margin: '0 0 8px', fontWeight: 650 }}>{section.heading}</h2>
            {section.blocks.map((block, index) => (
              <Block key={index} block={block} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function Block({ block }: { block: LegalBlock }) {
  const text: CSSProperties = { margin: '8px 0 0', color: 'var(--text-2)' };
  switch (block.kind) {
    case 'p':
      return <p style={text}>{linkify(block.text)}</p>;
    case 'list':
    case 'steps': {
      const List = block.kind === 'steps' ? 'ol' : 'ul';
      return (
        <List style={{ ...text, paddingLeft: 22 }}>
          {block.items.map((item) => (
            <li key={item} style={{ marginTop: 6 }}>{linkify(item)}</li>
          ))}
        </List>
      );
    }
  }
}

function LangSwitch({ id, lang }: { id: LegalPageId; lang: LegalLang }) {
  const option = (value: LegalLang, label: string) => (
    <Link
      to={legalPath(id, value)}
      replace
      aria-current={value === lang ? 'true' : undefined}
      style={{
        padding: '3px 9px',
        borderRadius: 6,
        fontSize: 12.5,
        fontWeight: 650,
        background: value === lang ? 'var(--seg-on)' : 'transparent',
        color: value === lang ? 'var(--text)' : 'var(--text-muted)',
      }}
    >
      {label}
    </Link>
  );
  return (
    <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--seg)' }}>
      {option('ru', 'RU')}
      {option('en', 'EN')}
    </div>
  );
}
