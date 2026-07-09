import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth-context';
import 'reactflow/dist/style.css';
import 'katex/dist/katex.min.css';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Cross River Assistant',
  description: 'AI-Powered Assistant Platform - multi-agent router with streaming responses',
  icons: {
    icon: [
      { url: '/favicon-32.jpg', sizes: '32x32', type: 'image/jpeg' },
      { url: '/favicon-192.jpg', sizes: '192x192', type: 'image/jpeg' },
    ],
    apple: [{ url: '/favicon-192.jpg', sizes: '192x192', type: 'image/jpeg' }],
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
