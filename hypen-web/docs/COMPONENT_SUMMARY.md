# Implemented Components & Applicators Summary

This document summarizes all components and applicators that have been implemented in the Hypen framework.

## Implemented Components (34 total)

### Layout (10)
- ✅ **Column** - Vertical flex container
- ✅ **Row** - Horizontal flex container
- ✅ **Container** / **Box** - Generic container
- ✅ **Center** - Centering container
- ✅ **Stack** - Overlaying container
- ✅ **Grid** - CSS Grid container
- ✅ **Spacer** - Flexible space
- ✅ **Divider** - Visual separator
- ✅ **List** - List container
- ✅ **SafeArea** - Container padded by device safe-area insets, optional `edges` filter ([props](./components/layout.md#safearea))

### Text (3)
- ✅ **Text** - Basic text display
- ✅ **Heading** - Semantic headings (h1-h6)
- ✅ **Paragraph** - Paragraph text

### Forms (7)
- ✅ **Input** - Text input field
- ✅ **Button** - Clickable button
- ✅ **Textarea** - Multi-line text input
- ✅ **Checkbox** - Checkbox with label
- ✅ **Select** - Dropdown select
- ✅ **Switch** - Toggle switch
- ✅ **Slider** - Range slider

### Media (4)
- ✅ **Image** - Image display
- ✅ **Video** - Video player: single `src` or `playlist` auto-advance, `poster`, auth `headers`, playback events ([docs](../../hypen-docs/content/docs/guide/components.mdx), [props](./components/media.md#video))
- ✅ **Audio** - Audio player
- ✅ **Icon** - SVG icon (driven by `@resources.xxx`)

### Display (5)
- ✅ **Card** - Card container with styling
- ✅ **Badge** - Status/label badge
- ✅ **Avatar** - User avatar
- ✅ **ProgressBar** - Progress indicator
- ✅ **Spinner** - Loading spinner

### Navigation & App Shell (5)
- ✅ **Link** - Hyperlink (declarative routing via `to`)
- ✅ **Router** - Route container
- ✅ **Route** - Route definition with path matching
- ✅ **App** - Top-level app container
- ✅ **HypenApp** - Default full-bleed app shell

---

## Implemented Applicators (120+ total)

### Layout & Positioning (27)
- ✅ **verticalAlignment** - Unified vertical positioning (main axis for Column, cross axis for Row)
- ✅ **horizontalAlignment** - Unified horizontal positioning (cross axis for Column, main axis for Row)
- ✅ **flexDirection** - Flex direction
- ✅ **weight** - Flex weight (cross-platform API, same as flex)
- ✅ **flexGrow** - Flex grow factor
- ✅ **flexShrink** - Flex shrink factor
- ✅ **flexBasis** - Flex basis size
- ✅ **alignContent** - Multi-line alignment
- ✅ **alignSelf** - Individual item alignment
- ✅ **order** - Flex item order
- ✅ **gap** - Spacing between items
- ✅ **rowGap** - Vertical gap
- ✅ **columnGap** - Horizontal gap
- ✅ **scrollable** - Enable scrolling (true, false, "vertical", "horizontal", "both")
- ✅ **gridColumn** - Grid column placement
- ✅ **placeItems** - Align and justify shorthand
- ✅ **placeContent** - Align and justify content
- ✅ **placeSelf** - Individual placement

### Positioning (7)
- ✅ **position** - Position type
- ✅ **top** - Top offset
- ✅ **right** - Right offset
- ✅ **bottom** - Bottom offset
- ✅ **left** - Left offset
- ✅ **inset** - All sides offset
- ✅ **zIndex** - Z-axis stacking

### Size & Spacing (21)
- ✅ **width** - Element width
- ✅ **height** - Element height
- ✅ **minWidth** - Minimum width
- ✅ **minHeight** - Minimum height
- ✅ **maxWidth** - Maximum width
- ✅ **maxHeight** - Maximum height
- ✅ **padding** - All padding
- ✅ **paddingTop** - Top padding
- ✅ **paddingRight** - Right padding
- ✅ **paddingBottom** - Bottom padding
- ✅ **paddingLeft** - Left padding
- ✅ **margin** - All margin
- ✅ **marginTop** - Top margin
- ✅ **marginRight** - Right margin
- ✅ **marginBottom** - Bottom margin
- ✅ **marginLeft** - Left margin
- ✅ **aspectRatio** - Width/height ratio
- ✅ **objectFit** - Image/video fit
- ✅ **objectPosition** - Image/video position
- ✅ **boxSizing** - Box model sizing
- ✅ **cursor** - Mouse cursor style

### Typography (19)
- ✅ **fontSize** - Font size
- ✅ **fontWeight** - Font weight
- ✅ **fontFamily** - Font family
- ✅ **fontStyle** - Font style (italic)
- ✅ **fontVariant** - Font variant
- ✅ **fontStretch** - Font stretch
- ✅ **textAlign** - Text alignment
- ✅ **textTransform** - Text case
- ✅ **textDecoration** - Text decoration
- ✅ **textDecorationColor** - Decoration color
- ✅ **textDecorationStyle** - Decoration style
- ✅ **textDecorationThickness** - Decoration thickness
- ✅ **letterSpacing** - Letter spacing
- ✅ **wordSpacing** - Word spacing
- ✅ **lineHeight** - Line height
- ✅ **textIndent** - Text indentation
- ✅ **textOverflow** - Overflow handling
- ✅ **whiteSpace** - Whitespace handling
- ✅ **wordBreak** - Word breaking
- ✅ **maxLines** - Limit text to N lines with ellipsis (uses -webkit-line-clamp)
- ✅ **verticalAlign** - Vertical alignment
- ✅ **writingMode** - Writing direction

### Color & Background (13)
- ✅ **color** - Text color
- ✅ **backgroundColor** - Background color
- ✅ **borderColor** - Border color
- ✅ **opacity** - Element opacity
- ✅ **backgroundImage** - Background image
- ✅ **backgroundSize** - Background size
- ✅ **backgroundPosition** - Background position
- ✅ **backgroundRepeat** - Background repeat
- ✅ **backgroundAttachment** - Background scroll
- ✅ **backgroundClip** - Background clip
- ✅ **backgroundOrigin** - Background origin
- ✅ **linearGradient** - Linear gradient
- ✅ **radialGradient** - Radial gradient
- ✅ **conicGradient** - Conic gradient

### Border (5)
- ✅ **borderWidth** - Border width
- ✅ **borderStyle** - Border style
- ✅ **borderRadius** - Border radius
- ✅ **borderColor** - Border color (in color handlers)

### Transform (16)
- ✅ **transform** - Transform property
- ✅ **transformOrigin** - Transform origin
- ✅ **translateX** - X translation
- ✅ **translateY** - Y translation
- ✅ **translateZ** - Z translation
- ✅ **rotate** - Rotation
- ✅ **rotateX** - X-axis rotation
- ✅ **rotateY** - Y-axis rotation
- ✅ **rotateZ** - Z-axis rotation
- ✅ **scale** - Uniform scale
- ✅ **scaleX** - X-axis scale
- ✅ **scaleY** - Y-axis scale
- ✅ **skew** - Skew transform
- ✅ **skewX** - X-axis skew
- ✅ **skewY** - Y-axis skew
- ✅ **perspective** - 3D perspective

### Visual Effects (15)
- ✅ **boxShadow** - Box shadow
- ✅ **textShadow** - Text shadow
- ✅ **filter** - CSS filters
- ✅ **backdropFilter** - Backdrop filter
- ✅ **blur** - Blur filter
- ✅ **brightness** - Brightness filter
- ✅ **contrast** - Contrast filter
- ✅ **grayscale** - Grayscale filter
- ✅ **hueRotate** - Hue rotation
- ✅ **invert** - Invert filter
- ✅ **saturate** - Saturation filter
- ✅ **sepia** - Sepia filter
- ✅ **dropShadow** - Drop shadow filter
- ✅ **mixBlendMode** - Blend mode
- ✅ **backgroundBlendMode** - Background blend
- ✅ **clipPath** - Clip path
- ✅ **mask** - Mask image
- ✅ **maskImage** - Mask image URL

### Transitions & Animations (14)
- ✅ **transition** - Transition property
- ✅ **transitionProperty** - Properties to transition
- ✅ **transitionDuration** - Transition duration
- ✅ **transitionTimingFunction** - Timing function
- ✅ **transitionDelay** - Transition delay
- ✅ **animation** - Animation property
- ✅ **animationName** - Animation name
- ✅ **animationDuration** - Animation duration
- ✅ **animationTimingFunction** - Animation timing
- ✅ **animationDelay** - Animation delay
- ✅ **animationIterationCount** - Iteration count
- ✅ **animationDirection** - Animation direction
- ✅ **animationFillMode** - Fill mode
- ✅ **animationPlayState** - Play state

### Display & Visibility (9)
- ✅ **display** - Display mode
- ✅ **visibility** - Visibility state
- ✅ **overflow** - Overflow behavior
- ✅ **overflowX** - Horizontal overflow
- ✅ **overflowY** - Vertical overflow
- ✅ **pointerEvents** - Pointer event handling
- ✅ **userSelect** - Text selection
- ✅ **resize** - Element resizing

### Event Handlers (Cross-Platform Support)

| Applicator | Description | Bun | Android |
|------------|-------------|-----|---------|
| **onClick** | Click/tap events | ✅ | ✅ |
| **onPress** | Alias for onClick | ✅ | ✅ |
| **onLongClick** | Long press (500ms threshold) | ✅ | ✅ |
| **onChange** | Form field change events | ✅ | ✅ |
| **onInput** | Real-time input events | ✅ | ✅ |
| **onFocus** | Focus events | ✅ | ✅ |
| **onBlur** | Blur events | ✅ | ✅ |
| **onSubmit** | Form submit events | ✅ | ❌ |
| **onScroll** | Scroll events (throttled) | ✅ | ❌ |
| **onKey** | Keyboard events | ✅ | ❌ |
| **onMouseEnter** | Mouse enter (web only) | ✅ | N/A |
| **onMouseLeave** | Mouse leave (web only) | ✅ | N/A |

**Notes:**
- `onMouseEnter`/`onMouseLeave` are web-only (no mouse on mobile)
- Android form events (onChange, onInput, onFocus, onBlur) are handled by the InputComponent

---

## Documentation Files Created

### Components
1. ✅ `/docs/README.md` - Main documentation index
2. ✅ `/docs/components/layout.md` - Layout components
3. ✅ `/docs/components/text.md` - Text components
4. ✅ `/docs/components/forms.md` - Form components
5. ✅ `/docs/components/media.md` - Media components
6. ✅ `/docs/components/display.md` - Display components
7. ✅ `/docs/components/navigation.md` - Navigation components

### Applicators (Ready to be created)
- `/docs/applicators/README.md` - Applicators overview
- `/docs/applicators/layout.md` - Layout applicators
- `/docs/applicators/size.md` - Size applicators
- `/docs/applicators/spacing.md` - Spacing applicators
- `/docs/applicators/typography.md` - Typography applicators
- `/docs/applicators/color.md` - Color applicators
- `/docs/applicators/border.md` - Border applicators
- `/docs/applicators/transform.md` - Transform applicators
- `/docs/applicators/effects.md` - Effects applicators
- `/docs/applicators/transition.md` - Transition applicators
- `/docs/applicators/display.md` - Display applicators
- `/docs/applicators/events.md` - Event applicators

---

## Next Steps

To complete the component library, the following could be added:

### High Priority Components (Not Yet Implemented)
These require functionality beyond just components/applicators:
- ScrollView (needs scroll container logic)
- Modal/Drawer (needs overlay/portal rendering)
- Tooltip/Popover (needs positioning logic)
- Dropdown menus (needs state management)
- Tabs (needs active state management)
- Accordion (needs expand/collapse logic)
- DatePicker/TimePicker (complex form controls)
- Autocomplete (needs filtering logic)
- Virtual lists (needs windowing logic)
- Drag & drop (needs drag API integration)

### Additional Applicators to Consider
- CSS variables (`cssVar`)
- Container queries (`containerType`, `containerName`)
- Pseudo-class handlers (`.hover()`, `.focus()`, `.active()`)
- Media query helpers
- Print-specific styles

Note: The items listed above require engine-level features, state management patterns, or advanced DOM manipulation that goes beyond simple component/applicator registration.


