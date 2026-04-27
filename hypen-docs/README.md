# Hypen Documentation

[![Fumadocs](https://img.shields.io/badge/Fumadocs-15-646CFF)](https://fumadocs.vercel.app/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

Official documentation site for the Hypen declarative UI language, built with [Fumadocs](https://fumadocs.vercel.app/) and Next.js.

## Overview

This package contains the source files for the Hypen documentation website, covering:

- **Getting Started** - Installation, quick start guides
- **Language Guide** - Hypen DSL syntax, components, styling
- **API Reference** - Applicators, components, modules
- **Platform Guides** - Web, iOS, Android renderer documentation

## Development

### Prerequisites

- Node.js 18+ or Bun 1.0+

### Local Development

```bash
# Install dependencies
bun install

# Start development server with hot reload
bun dev
```

### Build

```bash
# Build for production
bun run build

# Start production server
bun start
```

## Project Structure

```
hypen-docs/
├── app/                    # Next.js app router pages
│   ├── (home)/             # Landing page
│   ├── docs/               # Documentation pages
│   └── layout.tsx          # Root layout
├── content/
│   └── docs/               # MDX documentation files
├── components/             # React components
├── lib/                    # Utilities
├── public/                 # Static assets
├── source.config.ts        # Fumadocs source configuration
└── package.json
```

## Adding Documentation

1. Create or edit MDX files in `content/docs/`
2. The sidebar is auto-generated from the file structure (configure via `meta.json` files)
3. Use the `hypen` code fence for syntax highlighting:

````markdown
```hypen
Column {
    Text("Hello, Hypen!")
        .fontSize(24)
        .color(blue)
}
```
````

## License

MIT
