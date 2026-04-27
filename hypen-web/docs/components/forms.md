# Form Components

Interactive form elements for user input.

## Input

Single-line text input field.

**Props:**
- `value` (String): Current input value
- `placeholder` (String): Placeholder text
- `type` (String): Input type (`"text"`, `"email"`, `"password"`, `"number"`, etc.)
- `disabled` (Boolean): Disable the input
- `readonly` (Boolean): Make input read-only

**Example:**
```hypen
Input(
  value: @{state.email},
  placeholder: "Enter your email",
  type: "email"
)
```

**Styled Input:**
```hypen
Input(value: @{state.username})
  .width(300)
  .padding(12)
  .fontSize(16)
  .border("1px solid #ddd")
  .borderRadius(4)
```

**Rendered as:** `<input>`

---

## Button

Clickable button element.

**Props:**
- First positional argument: Button text
- `disabled` (Boolean): Disable the button

**Example:**
```hypen
Button("Click Me", @actions.handleClick)
```

**Styled Button:**
```hypen
Button("Submit")
  .padding(12, 24)
  .backgroundColor("#3498db")
  .color("#fff")
  .border("none")
  .borderRadius(6)
  .fontSize(16)
  .fontWeight("600")
  .cursor("pointer")
  .onClick(@actions.submit)
```

**Button States:**
```hypen
Button("Hover Me")
  .backgroundColor("#2ecc71")
  .color("#fff")
  .padding(10, 20)
  .borderRadius(4)
  .transition("all 0.3s ease")
```

**Rendered as:** `<button>`

---

## Textarea

Multi-line text input area.

**Props:**
- `value` (String): Current textarea value
- `placeholder` (String): Placeholder text
- `rows` (Number): Number of visible rows
- `cols` (Number): Number of visible columns
- `disabled` (Boolean): Disable the textarea
- `readonly` (Boolean): Make textarea read-only

**Example:**
```hypen
Textarea(
  value: @{state.comment},
  placeholder: "Enter your comment...",
  rows: 5
)
```

**Styled Textarea:**
```hypen
Textarea(value: @{state.bio})
  .width("100%")
  .padding(12)
  .fontSize(14)
  .border("1px solid #ddd")
  .borderRadius(4)
  .resize("vertical")
```

**Rendered as:** `<textarea>`

---

## Checkbox

Checkbox input with optional label.

**Props:**
- `checked` (Boolean): Checked state
- `disabled` (Boolean): Disable the checkbox
- `label` (String) or first positional argument: Label text

**Example:**
```hypen
Checkbox(
  checked: @{state.accepted},
  label: "I agree to the terms",
  @actions.toggleAccept
)
```

**Without Label:**
```hypen
Checkbox(checked: @{state.isActive})
```

**Rendered as:** `<label>` containing `<input type="checkbox">`

---

## Select

Dropdown select menu.

**Props:**
- `value` (String): Currently selected value
- `options` (Array): Array of options (strings or `{value, label, disabled}` objects)
- `disabled` (Boolean): Disable the select
- `multiple` (Boolean): Allow multiple selections

**Example:**
```hypen
Select(
  value: @{state.country},
  options: ["USA", "Canada", "Mexico"]
)
```

**With Object Options:**
```hypen
Select(
  value: @{state.plan},
  options: [
    { value: "free", label: "Free Plan" },
    { value: "pro", label: "Pro Plan" },
    { value: "enterprise", label: "Enterprise", disabled: true }
  ]
)
```

**Rendered as:** `<select>` with `<option>` children

---

## Switch

Toggle switch for boolean values.

**Props:**
- `on` (Boolean): Switch state
- `disabled` (Boolean): Disable the switch
- `label` (String) or first positional argument: Label text

**Example:**
```hypen
Switch(
  on: @{state.notifications},
  label: "Enable notifications",
  @actions.toggleNotifications
)
```

**Styled Switch:**
```hypen
Switch(on: @{state.darkMode})
  .marginBottom(16)
```

**Rendered as:** `<label>` with styled `<input type="checkbox">`

---

## Slider

Range slider input.

**Props:**
- `value` (Number): Current slider value
- `min` (Number): Minimum value (default: 0)
- `max` (Number): Maximum value (default: 100)
- `step` (Number): Step increment (default: 1)
- `disabled` (Boolean): Disable the slider

**Example:**
```hypen
Slider(
  value: @{state.volume},
  min: 0,
  max: 100,
  step: 5
)
```

**With Value Display:**
```hypen
Column().gap(8) {
  Row().gap(16).verticalAlignment("center") {
    Text("Volume:")
    Slider(value: @{state.volume}, min: 0, max: 100)
      .flex(1)
    Text(@{state.volume} + "%")
  }
}
```

**Rendered as:** `<input type="range">`

---

## Form Patterns

### Complete Form
```hypen
Column()
  .gap(16)
  .padding(20)
  .maxWidth(400) {
  
  Heading(level: 2, "Sign Up")
  
  Column().gap(8) {
    Text("Email").fontWeight("600")
    Input(
      value: @{state.email},
      type: "email",
      placeholder: "you@example.com"
    )
      .width("100%")
      .padding(10)
      .border("1px solid #ddd")
      .borderRadius(4)
  }
  
  Column().gap(8) {
    Text("Password").fontWeight("600")
    Input(
      value: @{state.password},
      type: "password",
      placeholder: "••••••••"
    )
      .width("100%")
      .padding(10)
      .border("1px solid #ddd")
      .borderRadius(4)
  }
  
  Checkbox(
    checked: @{state.terms},
    label: "I agree to the terms and conditions"
  )
  
  Button("Create Account")
    .width("100%")
    .padding(12)
    .backgroundColor("#3498db")
    .color("#fff")
    .border("none")
    .borderRadius(4)
    .fontSize(16)
    .fontWeight("600")
    .cursor("pointer")
    .onClick(@actions.signup)
}
```

### Form with Validation
```hypen
Column().gap(16) {
  Input(value: @{state.email})
    .width("100%")
    .padding(10)
    .border(@{state.emailError ? "2px solid red" : "1px solid #ddd"})
    .borderRadius(4)
  
  When(value: @{state.emailError}) {
    Case(match: true) {
      Text(@{state.emailError})
        .color("red")
        .fontSize(14)
    }
  }
}
```

### Settings Form
```hypen
Column().gap(24).padding(20) {
  Heading(level: 2, "Settings")
  
  Row().verticalAlignment("center").horizontalAlignment("space-between") {
    Column().gap(4) {
      Text("Dark Mode").fontWeight("600")
      Text("Use dark theme").fontSize(14).color("#666")
    }
    Switch(on: @{state.darkMode})
  }
  
  Divider()
  
  Row().verticalAlignment("center").horizontalAlignment("space-between") {
    Column().gap(4) {
      Text("Notifications").fontWeight("600")
      Text("Receive email updates").fontSize(14).color("#666")
    }
    Checkbox(checked: @{state.emailNotifications})
  }
  
  Divider()
  
  Column().gap(8) {
    Text("Language").fontWeight("600")
    Select(
      value: @{state.language},
      options: ["English", "Spanish", "French", "German"]
    )
      .width("100%")
      .padding(10)
      .border("1px solid #ddd")
      .borderRadius(4)
  }
}
```

## Event Handling

All form components support event handlers:
- `.onClick(@actions.handler)` - Button clicks
- `.onChange(@actions.handler)` - Input changes
- `.onInput(@actions.handler)` - Real-time input
- `.onFocus(@actions.handler)` - Focus events
- `.onBlur(@actions.handler)` - Blur events

See [Event Applicators](../applicators/events.md) for more details.

## Accessibility Tips

1. **Labels:** Always provide labels for inputs (use Text or Heading above inputs)
2. **Placeholders:** Use placeholders as hints, not labels
3. **Tab order:** Ensure logical tab navigation through forms
4. **Required fields:** Clearly mark required fields
5. **Error messages:** Show clear, specific error messages near problematic fields
6. **Disabled state:** Make disabled inputs visually distinct

## See Also
- [Event Applicators](../applicators/events.md)
- [Display Components](./display.md)


