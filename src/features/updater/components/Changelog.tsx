import React from 'react';

// Minimal inline-markdown renderer (bold, italic, code)
// IMPORTANT: regex must have NO nested capture groups — split() includes captured
// groups in the result, and nested groups produce undefined entries that crash on .startsWith()
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*'))
      return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="changelog-code">{part.slice(1, -1)}</code>;
    return part;
  });
}

/** Renders a GitHub release body as themed changelog markup. */
export default function Changelog({ body }: { body: string }) {
  return (
    <>
      {body.split('\n').map((line, i) => {
        if (line.startsWith('### '))
          return <div key={i} className="changelog-h3">{renderInline(line.slice(4))}</div>;
        if (line.startsWith('#### '))
          return <div key={i} className="changelog-h4">{renderInline(line.slice(5))}</div>;
        if (line.startsWith('## '))
          return null; // skip nested release headers in body
        if (line.startsWith('- '))
          return <div key={i} className="changelog-item">{renderInline(line.slice(2))}</div>;
        if (line.trim() === '') return null;
        return <div key={i} className="changelog-text">{renderInline(line)}</div>;
      })}
    </>
  );
}
