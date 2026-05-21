# Navigation Components

Components for navigation and linking.

## Link

Anchor element for creating hyperlinks (without routing logic).

**Props:**
- `href` (String) or first positional argument: Link destination URL
- `target` (String): Link target (`"_blank"`, `"_self"`, etc.)
- `rel` (String): Link relationship (e.g., `"noopener noreferrer"` for external links)

**Example:**
```hypen
Link(href: "/about", "About Us")
```

**External Link:**
```hypen
Link(
  href: "https://example.com",
  target: "_blank",
  rel: "noopener noreferrer"
) {
  Text("Visit Website")
}
```

**Styled Link:**
```hypen
Link(href: "/contact")
  .color("#3498db")
  .textDecoration("none")
  .fontWeight("600") {
  Text("Contact")
}
```

**Link with Hover:**
```hypen
Link(href: "/products")
  .color("#333")
  .textDecoration("none")
  .transition("color 0.2s") {
  Text("Products")
}
```

**Rendered as:** `<a>`

---

## Navigation Patterns

### Header Navigation
```hypen
Row()
  .padding(16)
  .backgroundColor("#fff")
  .boxShadow("0 2px 4px rgba(0,0,0,0.1)")
  .horizontalAlignment("space-between")
  .verticalAlignment("center") {

  Heading(level: 1, "Logo")
    .fontSize(24)
    .margin(0)

  Row().gap(24).verticalAlignment("center") {
    Link(href: "/", "Home")
      .color("#333")
      .textDecoration("none")
      .fontWeight("600")
    
    Link(href: "/about", "About")
      .color("#333")
      .textDecoration("none")
    
    Link(href: "/services", "Services")
      .color("#333")
      .textDecoration("none")
    
    Link(href: "/contact", "Contact")
      .color("#333")
      .textDecoration("none")
    
    Button("Sign In")
      .padding(8, 16)
  }
}
```

### Sidebar Navigation
```hypen
Column()
  .width(250)
  .height("100vh")
  .backgroundColor("#2c3e50")
  .padding(20) {
  
  Heading(level: 2, "Dashboard")
    .color("#fff")
    .marginBottom(32)
  
  Column().gap(8) {
    Link(href: "/dashboard")
      .color("#ecf0f1")
      .textDecoration("none")
      .padding(12)
      .borderRadius(4)
      .backgroundColor("rgba(255,255,255,0.1)") {
      Text("📊 Overview")
    }
    
    Link(href: "/projects")
      .color("#ecf0f1")
      .textDecoration("none")
      .padding(12)
      .borderRadius(4) {
      Text("📁 Projects")
    }
    
    Link(href: "/team")
      .color("#ecf0f1")
      .textDecoration("none")
      .padding(12)
      .borderRadius(4) {
      Text("👥 Team")
    }
    
    Link(href: "/settings")
      .color("#ecf0f1")
      .textDecoration("none")
      .padding(12)
      .borderRadius(4) {
      Text("⚙️ Settings")
    }
  }
}
```

### Breadcrumbs
```hypen
Row()
  .gap(8)
  .verticalAlignment("center")
  .fontSize(14) {

  Link(href: "/", "Home")
    .color("#3498db")
  Text("/").color("#999")
  
  Link(href: "/products", "Products")
    .color("#3498db")
  Text("/").color("#999")
  
  Text("Product Name")
    .color("#333")
}
```

### Footer Links
```hypen
Row()
  .padding(40, 20)
  .backgroundColor("#2c3e50")
  .horizontalAlignment("space-around") {

  Column().gap(16) {
    Text("Company")
      .color("#fff")
      .fontWeight("600")
      .marginBottom(8)
    
    Link(href: "/about", "About Us")
      .color("#ecf0f1")
      .textDecoration("none")
      .fontSize(14)
    
    Link(href: "/careers", "Careers")
      .color("#ecf0f1")
      .textDecoration("none")
      .fontSize(14)
    
    Link(href: "/press", "Press")
      .color("#ecf0f1")
      .textDecoration("none")
      .fontSize(14)
  }
  
  Column().gap(16) {
    Text("Resources")
      .color("#fff")
      .fontWeight("600")
      .marginBottom(8)
    
    Link(href: "/blog", "Blog")
      .color("#ecf0f1")
      .textDecoration("none")
      .fontSize(14)
    
    Link(href: "/docs", "Documentation")
      .color("#ecf0f1")
      .textDecoration("none")
      .fontSize(14)
    
    Link(href: "/support", "Support")
      .color("#ecf0f1")
      .textDecoration("none")
      .fontSize(14)
  }
  
  Column().gap(16) {
    Text("Legal")
      .color("#fff")
      .fontWeight("600")
      .marginBottom(8)
    
    Link(href: "/privacy", "Privacy")
      .color("#ecf0f1")
      .textDecoration("none")
      .fontSize(14)
    
    Link(href: "/terms", "Terms")
      .color("#ecf0f1")
      .textDecoration("none")
      .fontSize(14)
  }
}
```

### Tab Navigation
```hypen
Row()
  .borderBottom("2px solid #e0e0e0")
  .gap(0) {
  
  Link(href: "/tab1")
    .padding(12, 24)
    .textDecoration("none")
    .color("#333")
    .borderBottom("2px solid #3498db")
    .marginBottom(-2) {
    Text("Tab 1")
  }
  
  Link(href: "/tab2")
    .padding(12, 24)
    .textDecoration("none")
    .color("#666") {
    Text("Tab 2")
  }
  
  Link(href: "/tab3")
    .padding(12, 24)
    .textDecoration("none")
    .color("#666") {
    Text("Tab 3")
  }
}
```

### Social Links
```hypen
Row().gap(16) {
  Link(
    href: "https://twitter.com/company",
    target: "_blank",
    rel: "noopener noreferrer"
  )
    .color("#1DA1F2")
    .fontSize(24) {
    Text("🐦")
  }
  
  Link(
    href: "https://github.com/company",
    target: "_blank",
    rel: "noopener noreferrer"
  )
    .color("#333")
    .fontSize(24) {
    Text("📦")
  }
  
  Link(
    href: "https://linkedin.com/company/company",
    target: "_blank",
    rel: "noopener noreferrer"
  )
    .color("#0077B5")
    .fontSize(24) {
    Text("💼")
  }
}
```

### Card with Action Link
```hypen
Card {
  Column().gap(12) {
    Heading(level: 3, "Article Title")
    Text("Article description goes here...")
      .color("#666")
    
    Link(href: "/article/123", "Read more →")
      .color("#3498db")
      .textDecoration("none")
      .fontWeight("600")
      .fontSize(14)
  }
}
```

### Pagination Links
```hypen
Row()
  .gap(8)
  .horizontalAlignment("center")
  .verticalAlignment("center") {

  Link(href: "/page/1", "← Prev")
    .padding(8, 12)
    .border("1px solid #ddd")
    .borderRadius(4)
    .textDecoration("none")
    .color("#333")
  
  Link(href: "/page/1", "1")
    .padding(8, 12)
    .backgroundColor("#3498db")
    .color("#fff")
    .borderRadius(4)
    .textDecoration("none")
  
  Link(href: "/page/2", "2")
    .padding(8, 12)
    .border("1px solid #ddd")
    .borderRadius(4)
    .textDecoration("none")
    .color("#333")
  
  Link(href: "/page/3", "3")
    .padding(8, 12)
    .border("1px solid #ddd")
    .borderRadius(4)
    .textDecoration("none")
    .color("#333")
  
  Link(href: "/page/2", "Next →")
    .padding(8, 12)
    .border("1px solid #ddd")
    .borderRadius(4)
    .textDecoration("none")
    .color("#333")
}
```

## Accessibility Tips

1. **Meaningful text:** Link text should describe the destination ("Contact Us" not "Click here")
2. **External links:** Use `target="_blank"` with `rel="noopener noreferrer"` for security
3. **Keyboard navigation:** Links are keyboard accessible by default (Tab, Enter)
4. **Visual indication:** Ensure links are visually distinct (color, underline, or both)
5. **Focus styles:** Maintain visible focus indicators for keyboard users
6. **Skip links:** Consider adding skip-to-content links for long navigation

## Styling Best Practices

1. **Consistent styling:** Use consistent link colors throughout your app
2. **Hover states:** Add subtle hover effects to indicate interactivity
3. **Active/current state:** Highlight the current page in navigation
4. **Visited links:** Consider styling visited links differently (`:visited` pseudo-class)
5. **Touch targets:** Ensure links have adequate size (min 44x44px) for touch screens

## Note on Routing

The `Link` component creates standard HTML anchor tags without routing logic. For client-side routing in single-page applications, you'll need to implement routing separately or use a routing library that intercepts link clicks.

## See Also
- [Typography Applicators](../applicators/typography.md) - Text styling
- [Color Applicators](../applicators/color.md) - Link colors
- [Event Applicators](../applicators/events.md) - Click handlers


