import React from 'react';
import { open } from '@tauri-apps/plugin-shell';

/**
 * Render inline markdown segments: **bold**, *italic*, `code`, [text](url).
 * External links open in the user's default browser via the Tauri shell plugin.
 */
export function renderInlineMarkdown(text: string, keyPrefix = 'i'): React.ReactNode[] {
  // Tokenize — order matters: links first (no recursion), then emphasis/code.
  const tokens: React.ReactNode[] = [];
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  const pushInline = (segment: string) => {
    const parts = segment.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('**') && part.endsWith('**')) {
        tokens.push(<strong key={`${keyPrefix}-${i++}`}>{part.slice(2, -2)}</strong>);
      } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
        tokens.push(<em key={`${keyPrefix}-${i++}`}>{part.slice(1, -1)}</em>);
      } else if (part.startsWith('`') && part.endsWith('`')) {
        tokens.push(<code key={`${keyPrefix}-${i++}`} className="whats-new-code">{part.slice(1, -1)}</code>);
      } else {
        tokens.push(part);
      }
    }
  };

  while ((match = linkRe.exec(text)) !== null) {
    if (match.index > lastIndex) pushInline(text.slice(lastIndex, match.index));
    const [full, label, url] = match;
    tokens.push(
      <a
        key={`${keyPrefix}-link-${i++}`}
        href={url}
        onClick={(e) => { e.preventDefault(); open(url).catch(() => {}); }}
        className="whats-new-link"
      >
        {label}
      </a>
    );
    lastIndex = match.index + full.length;
  }
  if (lastIndex < text.length) pushInline(text.slice(lastIndex));

  return tokens;
}

/**
 * Render a subset of GitHub-flavored Markdown used by our CHANGELOG: headings
 * (### / ####), bullets (- / *), blockquotes, horizontal rules, and inline
 * formatting (bold/italic/code/links).
 */
export function renderChangelogBody(body: string): React.ReactNode[] {
  const lines = body.split('\n');
  const out: React.ReactNode[] = [];
  let bulletBuffer: React.ReactNode[] = [];
  let quoteBuffer: string[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length === 0) return;
    out.push(<ul key={`ul-${out.length}`} className="whats-new-list">{bulletBuffer}</ul>);
    bulletBuffer = [];
  };
  const flushQuote = () => {
    if (quoteBuffer.length === 0) return;
    out.push(
      <blockquote key={`q-${out.length}`} className="whats-new-quote">
        {renderInlineMarkdown(quoteBuffer.join(' '), `q-${out.length}`)}
      </blockquote>
    );
    quoteBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { flushBullets(); flushQuote(); continue; }

    if (trimmed === '---') {
      flushBullets(); flushQuote();
      out.push(<hr key={`hr-${out.length}`} className="whats-new-hr" />);
      continue;
    }

    if (line.startsWith('### ')) {
      flushBullets(); flushQuote();
      out.push(<h3 key={`h3-${out.length}`} className="whats-new-h3">{renderInlineMarkdown(line.slice(4), `h3-${i}`)}</h3>);
      continue;
    }
    if (line.startsWith('#### ')) {
      flushBullets(); flushQuote();
      out.push(<h4 key={`h4-${out.length}`} className="whats-new-h4">{renderInlineMarkdown(line.slice(5), `h4-${i}`)}</h4>);
      continue;
    }

    if (line.startsWith('> ')) {
      flushBullets();
      quoteBuffer.push(line.slice(2));
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      flushQuote();
      bulletBuffer.push(
        <li key={`li-${i}`}>{renderInlineMarkdown(line.slice(2), `li-${i}`)}</li>
      );
      continue;
    }

    // Paragraph / plain line
    flushBullets(); flushQuote();
    out.push(<p key={`p-${i}`} className="whats-new-p">{renderInlineMarkdown(line, `p-${i}`)}</p>);
  }
  flushBullets(); flushQuote();
  return out;
}
