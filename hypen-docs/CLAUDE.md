# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen documentation site.

## Project Overview

`hypen-docs` is the official documentation site for Hypen, built with Fumadocs and Next.js. It covers getting started guides, language reference, API documentation, and platform-specific guides.

## Development Commands

```bash
bun install                # Install dependencies
bun dev                    # Development server with hot reload
bun run build              # Production build
bun start                  # Serve production build
```

## Architecture

- **Framework**: Next.js 15 (App Router)
- **Docs Engine**: Fumadocs (MDX-based documentation framework)
- **Styling**: Tailwind CSS v4
- **Content**: MDX files with Hypen DSL syntax highlighting via Shiki

## App Router Structure

- `app/(home)/page.tsx` — Home page
- `app/docs/[[...slug]]/page.tsx` — Docs catch-all route
- `app/docs/layout.tsx` — Docs layout
- `content/docs/` — MDX content with subdirectories (guide/, getting-started/, adapters/, etc.)

## Adding Documentation

1. Create an MDX file in the appropriate `content/docs/` subdirectory
2. Add frontmatter with title and description
3. Update the `meta.json` file in the subdirectory to control sidebar ordering and section grouping
4. Use code blocks with `hypen` language for syntax highlighting (powered by custom TextMate grammar at `lib/hypen.tmLanguage.json`)

## Key Dependencies

- Next.js 15, React 19
- fumadocs-core, fumadocs-mdx, fumadocs-ui
- Shiki (syntax highlighting)
- Tailwind CSS v4
