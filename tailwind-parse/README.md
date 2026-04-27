# hypen-tailwind-parse

Minimal Tailwind CSS class parser for Hypen. Converts Tailwind utility classes into style property maps that the Hypen engine can apply to elements.

## Usage

Used by the Hypen engine when processing `.tw("...")` applicators in the Hypen DSL:

```hypen
Text("Hello").tw("p-4 text-blue-500 rounded-xl bg-white")
```

The parser maps each Tailwind class to its corresponding CSS properties, which are then merged into the element's style.

## Supported Utilities

- **Spacing**: `p-*`, `m-*`, `gap-*` (padding, margin, gap)
- **Sizing**: `w-*`, `h-*`, `min-w-*`, `max-w-*`, `min-h-*`, `max-h-*`
- **Typography**: `text-*`, `font-*`, `leading-*`
- **Colors**: Full Tailwind color palette (`text-blue-500`, `bg-red-200`, etc.)
- **Backgrounds**: `bg-*`
- **Borders**: `border-*`, `rounded-*`
- **Layout**: `flex`, `grid`, display, position utilities
- **Transforms**: `rotate-*`, `scale-*`, `translate-*`
- **Effects**: `opacity-*`, `shadow-*`, `blur-*`
- **Tables**: Table-related utilities
- **Interactivity**: `cursor-*`, `select-*`, `scroll-*`

## Development

```bash
cargo test      # Run all tests
cargo build     # Build
cargo clippy    # Lint
```

## License

MIT
