# Display Components

Visual components for displaying data, status, and feedback.

## Card

Container component with default card styling (padding, shadow, border-radius).

**Props:**
- None (use applicators for custom styling)

**Example:**
```hypen
Card {
  Heading(level: 3, "Card Title")
  Text("Card content goes here")
}
```

**Custom Styled Card:**
```hypen
Card()
  .padding(24)
  .borderRadius(12)
  .boxShadow("0 4px 6px rgba(0,0,0,0.1)")
  .backgroundColor("#fff") {
  
  Column().gap(12) {
    Heading(level: 3, "Premium Plan")
    Text("$29/month")
    Button("Subscribe")
  }
}
```

**Rendered as:** `<div>` with default card styling

---

## Badge

Small colored label for status, counts, or categories.

**Props:**
- `text` (String) or first positional argument: Badge text
- `theme` (String): Color theme - `"success"`, `"error"`, `"warning"`, `"info"`, `"default"`

**Example:**
```hypen
Badge(theme: "success", "Active")
```

**Badge with Count:**
```hypen
Row().verticalAlignment("center").gap(8) {
  Text("Notifications")
  Badge(theme: "error", @{state.unreadCount})
}
```

**Status Badges:**
```hypen
Row().gap(8) {
  Badge(theme: "success", "Active")
  Badge(theme: "warning", "Pending")
  Badge(theme: "error", "Failed")
  Badge(theme: "info", "Info")
}
```

**Rendered as:** `<span>` with badge styling

---

## Avatar

Circular avatar image or initials display.

**Props:**
- `src` (String): Image source URL
- `initials` (String): Text initials to display (if no image)
- `size` (Number | String): Avatar size (default: 40px)

**Example:**
```hypen
Avatar(src: @{state.user.avatar})
```

**With Initials Fallback:**
```hypen
Avatar(
  src: @{state.user.profilePic},
  initials: @{state.user.initials}
)
```

**Different Sizes:**
```hypen
Row().gap(16).verticalAlignment("center") {
  Avatar(src: "user.jpg", size: 32)
  Avatar(src: "user.jpg", size: 48)
  Avatar(src: "user.jpg", size: 64)
}
```

**Initials Only:**
```hypen
Avatar(initials: "JD", size: 50)
  .backgroundColor("#9c27b0")
```

**Rendered as:** `<div>` with circular styling

---

## ProgressBar

Horizontal progress indicator.

**Props:**
- `value` (Number): Current progress value
- `max` (Number): Maximum value (default: 100)
- `color` (String): Bar color
- `height` (Number | String): Bar height

**Example:**
```hypen
ProgressBar(value: @{state.progress}, max: 100)
```

**With Label:**
```hypen
Column().gap(8) {
  Row().horizontalAlignment("space-between") {
    Text("Upload Progress")
    Text(@{state.progress} + "%")
  }
  
  ProgressBar(value: @{state.progress})
    .color("#3498db")
}
```

**Custom Styled:**
```hypen
ProgressBar(value: 75, max: 100)
  .height(12)
  .color("#2ecc71")
  .backgroundColor("#e0e0e0")
  .borderRadius(6)
```

**Rendered as:** `<div>` container with inner bar

---

## Spinner

Loading spinner animation.

**Props:**
- `size` (String | Number): Spinner size - `"small"`, `"medium"`, `"large"` or pixel value
- `color` (String): Spinner color

**Example:**
```hypen
Spinner()
```

**Different Sizes:**
```hypen
Row().gap(16).verticalAlignment("center") {
  Spinner(size: "small")
  Spinner(size: "medium")
  Spinner(size: "large")
}
```

**Custom Color:**
```hypen
Spinner(size: "large", color: "#3498db")
```

**Loading State:**
```hypen
When(value: @{state.loading}) {
  Case(match: true) {
    Center()
      .width("100%")
      .height(200) {
      Spinner(size: "large")
    }
  }
  Case(match: false) {
    // Content
  }
}
```

**Rendered as:** `<div>` with animated inner spinner

---

## List

Basic list container component.

**Props:**
- None (use applicators for styling)

**Example:**
```hypen
List {
  ForEach(items: @{state.items}) {
    Row()
      .padding(12)
      .borderBottom("1px solid #e0e0e0") {
      Text(@{item.name})
    }
  }
}
```

**Rendered as:** `<div>` (can be styled as ul/ol with appropriate styling)

---

## Display Patterns

### User Profile Card
```hypen
Card()
  .padding(24) {
  
  Row()
    .gap(16)
    .verticalAlignment("center") {

    Avatar(
      src: @{state.user.avatar},
      initials: @{state.user.initials},
      size: 64
    )

    Column().gap(4) {
      Row().gap(8).verticalAlignment("center") {
        Heading(level: 3, @{state.user.name})
          .marginBottom(0)
        Badge(theme: "success", "Pro")
      }
      
      Text(@{state.user.email})
        .color("#666")
        .fontSize(14)
    }
  }
}
```

### Stats Dashboard
```hypen
Grid(columns: 3, gap: 16) {
  Card().padding(20) {
    Column().gap(8) {
      Text("Total Users")
        .fontSize(14)
        .color("#666")
      Text(@{state.stats.users})
        .fontSize(32)
        .fontWeight("bold")
      Badge(theme: "success", "+12%")
    }
  }
  
  Card().padding(20) {
    Column().gap(8) {
      Text("Revenue")
        .fontSize(14)
        .color("#666")
      Text("$" + @{state.stats.revenue})
        .fontSize(32)
        .fontWeight("bold")
      Badge(theme: "success", "+8%")
    }
  }
  
  Card().padding(20) {
    Column().gap(8) {
      Text("Active Projects")
        .fontSize(14)
        .color("#666")
      Text(@{state.stats.projects})
        .fontSize(32)
        .fontWeight("bold")
      Badge(theme: "warning", "-3%")
    }
  }
}
```

### Loading Overlay
```hypen
When(value: @{state.isLoading}) {
  Case(match: true) {
    Container()
      .position("fixed")
      .top(0)
      .left(0)
      .width("100%")
      .height("100%")
      .backgroundColor("rgba(0,0,0,0.5)")
      .display("flex")
      .horizontalAlignment("center")
      .verticalAlignment("center")
      .zIndex(1000) {

      Column()
        .backgroundColor("#fff")
        .padding(32)
        .borderRadius(8)
        .horizontalAlignment("center")
        .gap(16) {
        
        Spinner(size: "large")
        Text("Loading...")
          .fontSize(18)
      }
    }
  }
}
```

### Progress Tracker
```hypen
Column().gap(24).padding(20) {
  Heading(level: 2, "Setup Progress")
  
  Column().gap(16) {
    Column().gap(8) {
      Row().horizontalAlignment("space-between") {
        Text("Profile Setup")
        Text("100%")
      }
      ProgressBar(value: 100, max: 100)
        .color("#2ecc71")
    }
    
    Column().gap(8) {
      Row().horizontalAlignment("space-between") {
        Text("Team Members")
        Text("60%")
      }
      ProgressBar(value: 60, max: 100)
        .color("#3498db")
    }
    
    Column().gap(8) {
      Row().horizontalAlignment("space-between") {
        Text("Integrations")
        Text("30%")
      }
      ProgressBar(value: 30, max: 100)
        .color("#f39c12")
    }
  }
}
```

### Status List
```hypen
Card {
  Column {
    ForEach(items: @{state.tasks}) {
      Row()
        .padding(16)
        .borderBottom("1px solid #e0e0e0")
        .verticalAlignment("center")
        .horizontalAlignment("space-between") {

        Row().gap(12).verticalAlignment("center") {
          Avatar(initials: @{item.assignee}, size: 32)
          
          Column().gap(4) {
            Text(@{item.title})
              .fontWeight("600")
            Text(@{item.description})
              .fontSize(14)
              .color("#666")
          }
        }
        
        Badge(
          theme: @{item.status},
          @{item.statusLabel}
        )
      }
    }
  }
}
```

### Notification Badge
```hypen
Container()
  .position("relative") {
  
  Button("Notifications")
    .padding(8, 16)
  
  When(value: @{state.unreadCount > 0}) {
    Case(match: true) {
      Badge(theme: "error", @{state.unreadCount})
        .position("absolute")
        .top(-8)
        .right(-8)
        .borderRadius("50%")
        .minWidth(20)
        .height(20)
        .fontSize(11)
    }
  }
}
```

## Design Tips

1. **Card spacing:** Use consistent padding (16-24px) and gaps between cards
2. **Visual hierarchy:** Use badges to draw attention to important status
3. **Loading states:** Always show spinners during async operations
4. **Progress feedback:** Use progress bars for multi-step or lengthy operations
5. **Avatars:** Provide fallback initials when images fail to load

## See Also
- [Layout Components](./layout.md) - Containers and positioning
- [Effects Applicators](../applicators/effects.md) - Shadows and visual effects
- [Color Applicators](../applicators/color.md) - Background and text colors


