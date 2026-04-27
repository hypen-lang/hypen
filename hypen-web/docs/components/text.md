# Text Components

Components for displaying and formatting text content.

## Text

Basic text display component.

**Props:**
- `text` (String) or first positional argument: Text content to display

**Example:**
```hypen
Text("Hello, World!")
```

**With State:**
```hypen
Text(@{state.username})
```

**Styled Text:**
```hypen
Text("Important notice")
  .fontSize(18)
  .fontWeight("bold")
  .color("#e74c3c")
```

**Rendered as:** `<span>` with `display: inline-block;`

---

## Heading

Semantic heading element (h1-h6) for titles and section headers.

**Props:**
- `level` (Number): Heading level from 1-6 (default: 2)
- `text` (String) or first positional argument: Heading text

**Example:**
```hypen
Heading(level: 1, "Page Title")
```

**With Styling:**
```hypen
Heading(level: 2)
  .fontSize(24)
  .fontWeight("600")
  .color("#2c3e50")
  .marginBottom(16) {
  Text("Section Title")
}
```

**All Heading Levels:**
```hypen
Column().gap(16) {
  Heading(level: 1, "Heading 1")
  Heading(level: 2, "Heading 2")
  Heading(level: 3, "Heading 3")
  Heading(level: 4, "Heading 4")
  Heading(level: 5, "Heading 5")
  Heading(level: 6, "Heading 6")
}
```

**Rendered as:** `<h1>` through `<h6>` depending on level

---

## Paragraph

Paragraph element for body text and longer content blocks.

**Props:**
- `text` (String) or first positional argument: Paragraph text

**Example:**
```hypen
Paragraph("This is a paragraph with multiple sentences. It can contain longer blocks of text that are semantically marked up as a paragraph.")
```

**Styled Paragraph:**
```hypen
Paragraph()
  .lineHeight("1.6")
  .marginBottom(16)
  .color("#333") {
  
  Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit.")
}
```

**Rendered as:** `<p>`

---

## Typography Patterns

### Article Header
```hypen
Column().gap(8).marginBottom(24) {
  Heading(level: 1)
    .fontSize(36)
    .fontWeight("700")
    .color("#1a1a1a") {
    Text("Article Title")
  }
  
  Text("By Author Name • January 15, 2024")
    .fontSize(14)
    .color("#666")
}
```

### Text Hierarchy
```hypen
Column().gap(16) {
  Heading(level: 1, "Main Title")
    .fontSize(32)
    .fontWeight("bold")
  
  Heading(level: 2, "Subtitle")
    .fontSize(24)
    .fontWeight("600")
    .color("#555")
  
  Paragraph("Body text content goes here.")
    .lineHeight("1.6")
    .fontSize(16)
  
  Text("Small helper text")
    .fontSize(12)
    .color("#888")
}
```

### Emphasized Text
```hypen
Row().gap(8).verticalAlignment("baseline") {
  Text("Regular text")
  
  Text("Bold text")
    .fontWeight("bold")
  
  Text("Italic text")
    .fontStyle("italic")
  
  Text("Underlined")
    .textDecoration("underline")
}
```

### Truncated Text
```hypen
Text(@{state.longDescription})
  .maxWidth(300)
  .whiteSpace("nowrap")
  .overflow("hidden")
  .textOverflow("ellipsis")
```

### Text with Shadow
```hypen
Heading(level: 1, "Hero Title")
  .fontSize(48)
  .fontWeight("800")
  .color("#fff")
  .textShadow("2px 2px 4px rgba(0, 0, 0, 0.5)")
```

### Monospace Code Text
```hypen
Text("const example = 'code';")
  .fontFamily("monospace")
  .fontSize(14)
  .backgroundColor("#f5f5f5")
  .padding(8)
  .borderRadius(4)
```

### Multi-line Text Limit
```hypen
// Simple approach using maxLines applicator
Text(@{state.description})
  .maxLines(3)

// Or for Paragraph
Paragraph(@{state.description})
  .maxLines(2)
```

## Text Styling Applicators

All text styling is done via applicators (not component arguments):

| Applicator | Description | Example |
|------------|-------------|---------|
| `.fontSize(value)` | Font size in pixels | `.fontSize(18)` |
| `.fontWeight(value)` | Font weight | `.fontWeight(bold)` |
| `.fontStyle(value)` | Font style | `.fontStyle(italic)` |
| `.color(value)` | Text color | `.color(blue)` or `.color("#333")` |
| `.textAlign(value)` | Text alignment | `.textAlign(center)` |
| `.lineHeight(value)` | Line height | `.lineHeight(1.5)` |
| `.letterSpacing(value)` | Letter spacing | `.letterSpacing(0.5)` |
| `.textDecoration(value)` | Text decoration | `.textDecoration(underline)` |
| `.maxLines(value)` | Limit to N lines with ellipsis | `.maxLines(2)` |
| `.overflow(value)` | Overflow behavior | `.overflow(ellipsis)` |

See [Typography Applicators](../applicators/typography.md) for more detailed styling options.

## Accessibility Tips

1. **Use semantic headings:** Always use `Heading` components for titles, not styled `Text`
2. **Heading hierarchy:** Maintain proper heading order (h1 → h2 → h3, don't skip levels)
3. **Readable line height:** Use `lineHeight("1.5")` to `lineHeight("1.8")` for body text
4. **Sufficient contrast:** Ensure text color contrasts well with background (WCAG AA: 4.5:1 for normal text)
5. **Responsive font sizes:** Consider using relative units or responsive scaling

## See Also
- [Typography Applicators](../applicators/typography.md)
- [Color Applicators](../applicators/color.md)


