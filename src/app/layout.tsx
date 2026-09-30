import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Poppet',
  description: 'Your personal agent',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-dvh antialiased">{children}</body>
    </html>
  );
}
