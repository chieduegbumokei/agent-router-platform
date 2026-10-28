import Link from 'next/link';

/**
 * 404 page — white canvas, brand logo top-left, a "dead route" illustration
 * (the router glyph with one dashed branch ending in a "?") centered above a
 * small 404 eyebrow, a big friendly headline, a muted sub-line and a single
 * "Go home" button. Server component: no client state.
 */
export default function NotFound() {
  return (
    <div className="nf">
      <header className="nf-bar">
        <Link href="/" className="nf-brand" aria-label="Home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Agent Router" />
        </Link>
      </header>

      <main className="nf-hero">
        <svg className="nf-art" viewBox="0 0 320 200" role="img" aria-label="A route that leads nowhere">
          <path className="nf-route" d="M54 100 C130 100 150 40 236 40" />
          <path className="nf-route" d="M54 100 C130 100 150 160 236 160" />
          <path className="nf-route nf-route-dead" d="M54 100 H226" />

          <circle className="nf-node-origin" cx="44" cy="100" r="18" />
          <circle className="nf-node-origin-dot" cx="44" cy="100" r="7" />
          <circle className="nf-node-agent" cx="248" cy="40" r="13" />
          <circle className="nf-node-agent" cx="248" cy="160" r="13" />

          <g className="nf-lost">
            <circle className="nf-node-lost" cx="252" cy="100" r="25" />
            <text className="nf-node-lost-mark" x="252" y="110" textAnchor="middle">
              ?
            </text>
          </g>
        </svg>

        <p className="nf-eyebrow">404 &middot; Route not found</p>
        <h1 className="nf-title">This route doesn&rsquo;t lead anywhere.</h1>
        <p className="nf-lead">The router couldn&rsquo;t find an agent for this page. Let&rsquo;s get you back on track.</p>
        <Link href="/" className="nf-btn">
          Go home
        </Link>
      </main>
    </div>
  );
}
