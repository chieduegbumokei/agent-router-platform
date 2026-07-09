'use client';

import { Check, Copy } from 'lucide-react';
import { isValidElement, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/**
 * Assistant output is model-generated → untrusted. rehype-sanitize runs FIRST
 * (strips any HTML/script vectors - XSS control, LLD §10); KaTeX and
 * highlight.js then annotate the already-clean tree. The schema only widens
 * the default with the class names those two plugins key off.
 */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-./, 'math-inline', 'math-display'],
    ],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', 'math', 'math-inline']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'math', 'math-display']],
  },
};

/** Recursively flatten a rendered <code> subtree back to copyable text. */
function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = isValidElement(children)
    ? (children.props as { children?: ReactNode; className?: string })
    : null;
  const language = code?.className?.match(/language-([\w+-]+)/)?.[1] ?? '';
  const text = nodeText(children);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (http origin) - button simply does nothing */
    }
  }

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{language || 'code'}</span>
        <button type="button" className="codeblock-copy" onClick={copy} aria-label="Copy code">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        [rehypeSanitize, schema],
        rehypeKatex,
        [rehypeHighlight, { detect: false }],
      ]}
      components={{
        pre: CodeBlock,
        // tables scroll inside their own container instead of widening the bubble
        table: (props) => (
          <div className="md-table-wrap">
            <table {...props} />
          </div>
        ),
        a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
