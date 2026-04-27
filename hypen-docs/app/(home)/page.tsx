import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center text-center px-4 py-24 min-h-[calc(100vh-4rem)]">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Badge */}
        <div className="inline-flex items-center rounded-full border border-fd-border bg-fd-card/50 px-4 py-1.5 text-sm text-fd-muted-foreground backdrop-blur">
          <span className="mr-2">📚</span>
          Documentation
        </div>

        {/* Main heading */}
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight">
          <span className="hypen-text-gradient">Hypen</span>{' '}
          <span className="text-fd-foreground">Documentation</span>
        </h1>

        {/* Tagline */}
        <p className="text-xl md:text-2xl text-fd-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Build native apps for <span className="text-fd-foreground font-medium">Web</span>,{' '}
          <span className="text-fd-foreground font-medium">Android</span>, and{' '}
          <span className="text-fd-foreground font-medium">iOS</span> from a single codebase
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-wrap justify-center gap-4 pt-4">
          <Link
            href="/docs"
            className="inline-flex items-center justify-center rounded-full px-8 py-3 text-base font-semibold transition-all hypen-glow"
            style={{ backgroundColor: 'var(--hypen-pink)', color: '#000' }}
          >
            Get Started
          </Link>
          <Link
            href="/docs/guide/components"
            className="inline-flex items-center justify-center rounded-full border border-fd-border bg-fd-card/50 px-8 py-3 text-base font-medium text-fd-foreground transition-colors hover:bg-fd-accent backdrop-blur"
          >
            View Components
          </Link>
        </div>

        {/* Feature cards */}
        <div className="grid gap-6 md:grid-cols-3 pt-16">
          <div className="rounded-xl border border-fd-border bg-fd-card/30 p-6 text-left backdrop-blur transition-colors hover:border-[var(--hypen-pink)]/30 hover:bg-fd-card/50">
            <div className="mb-3 text-2xl">🚀</div>
            <h3 className="font-semibold mb-2 text-fd-foreground">Write Once, Run Everywhere</h3>
            <p className="text-sm text-fd-muted-foreground leading-relaxed">
              Define your UI once and deploy to Web, Android, and iOS. Hypen
              renders to native components on each platform.
            </p>
          </div>
          <div className="rounded-xl border border-fd-border bg-fd-card/30 p-6 text-left backdrop-blur transition-colors hover:border-[var(--hypen-pink)]/30 hover:bg-fd-card/50">
            <div className="mb-3 text-2xl">⚡</div>
            <h3 className="font-semibold mb-2 text-fd-foreground">Declarative & Reactive</h3>
            <p className="text-sm text-fd-muted-foreground leading-relaxed">
              Simple, intuitive syntax with automatic UI updates when state
              changes. Focus on what your UI should look like.
            </p>
          </div>
          <div className="rounded-xl border border-fd-border bg-fd-card/30 p-6 text-left backdrop-blur transition-colors hover:border-[var(--hypen-pink)]/30 hover:bg-fd-card/50">
            <div className="mb-3 text-2xl">🔒</div>
            <h3 className="font-semibold mb-2 text-fd-foreground">TypeScript-Powered State</h3>
            <p className="text-sm text-fd-muted-foreground leading-relaxed">
              Type-safe state management with modules, actions, and lifecycle
              hooks. Full async support for API calls.
            </p>
          </div>
        </div>

        {/* Quick links */}
        <div className="pt-8 text-sm text-fd-muted-foreground">
          <span>Quick links: </span>
          <Link href="/docs/getting-started/installation" className="text-[var(--hypen-pink)] hover:underline">
            Installation
          </Link>
          {' • '}
          <Link href="/docs/getting-started/your-first-app" className="text-[var(--hypen-pink)] hover:underline">
            First App
          </Link>
          {' • '}
          <Link href="/docs/guide/layout" className="text-[var(--hypen-pink)] hover:underline">
            Layout Guide
          </Link>
        </div>
      </div>
    </main>
  );
}
