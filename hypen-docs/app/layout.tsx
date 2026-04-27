import './global.css';
import { RootProvider } from 'fumadocs-ui/provider';
import type { ReactNode } from 'react';

export const metadata = {
  title: {
    default: 'Hypen - Cross-platform UI Language',
    template: '%s | Hypen Docs',
  },
  description:
    'Build native apps for Web, Android, and iOS from a single codebase with Hypen declarative UI language.',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body className="flex flex-col min-h-screen">
        <RootProvider
          theme={{
            enabled: false,
          }}
        >{children}</RootProvider>
      </body>
    </html>
  );
}
