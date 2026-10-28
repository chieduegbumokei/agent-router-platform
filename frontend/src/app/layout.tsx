import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth-context';
import 'reactflow/dist/style.css';
import 'katex/dist/katex.min.css';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Agent Router Assistant',
  description: 'AI-Powered Assistant Platform - multi-agent router with streaming responses',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
