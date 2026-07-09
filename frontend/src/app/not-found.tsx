import Link from 'next/link';

/**
 * 404 page — white canvas, brand logo top-left, the Cross River astronaut
 * mascot centered above a big friendly headline, a muted sub-line and a
 * single small "Go home" button. Server component: no client state.
 */
export default function NotFound() {
  return (
    <div className="nf">
      <header className="nf-bar">
        <Link href="/" className="nf-brand" aria-label="Home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Cross River" />
        </Link>
      </header>

      <main className="nf-hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="nf-mascot"
          src="/mascot-404.png"
          alt="The Cross River astronaut mascot, looking a little lost"
          width={998}
          height={998}
        />
        <h1 className="nf-title">Uh-oh&hellip; I think I took a wrong turn.</h1>
        <p className="nf-lead">Let&rsquo;s get you back to where you were headed.</p>
        <Link href="/" className="nf-btn">
          Go home
        </Link>
      </main>
    </div>
  );
}
