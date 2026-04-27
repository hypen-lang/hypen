# Hypen Component Gallery Server

A comprehensive showcase of all Hypen components and applicators, served via WebSocket for the Android/iOS renderers.

## Running the Server

```bash
cd component-gallery-server
bun run server.ts
```

## Components (28)

| Component | Port | Description |
|-----------|------|-------------|
| Column | 4000 | Vertical stack container |
| Row | 4001 | Horizontal stack container |
| Text | 4002 | Text display |
| Button | 4003 | Interactive button |
| Image | 4004 | Image display |
| Container | 4005 | Generic container |
| Center | 4006 | Centers content |
| List | 4007 | Scrollable list |
| Input | 4008 | Text input field |
| Link | 4009 | Navigation link |
| TextArea | 4010 | Multi-line text input |
| Checkbox | 4011 | Toggle checkbox |
| Select | 4012 | Dropdown selection |
| Spacer | 4013 | Flexible space |
| Stack | 4014 | Overlays children |
| Divider | 4015 | Visual separator |
| Grid | 4016 | Grid layout |
| Card | 4017 | Styled card container |
| Heading | 4018 | Semantic heading |
| Switch | 4019 | Toggle switch |
| Slider | 4020 | Range slider |
| Spinner | 4021 | Loading indicator |
| Badge | 4022 | Status badge |
| Avatar | 4023 | User avatar |
| ProgressBar | 4024 | Progress indicator |
| Video | 4025 | Video player |
| Audio | 4026 | Audio player |
| Paragraph | 4027 | Block of text |

## Applicators (35)

| Applicator | Port | Description |
|------------|------|-------------|
| padding | 4028 | Internal spacing |
| margin | 4029 | External spacing |
| color | 4030 | Text color |
| backgroundColor | 4031 | Background color |
| opacity | 4032 | Transparency |
| width | 4033 | Element width |
| height | 4034 | Element height |
| size | 4035 | Width and height |
| fillMaxSize | 4036 | Fill available space |
| border | 4037 | Border styling |
| borderRadius | 4038 | Rounded corners |
| cornerRadius | 4039 | Rounded corners (alias) |
| fontSize | 4040 | Text size |
| fontWeight | 4041 | Text weight |
| fontFamily | 4042 | Font family |
| textAlign | 4043 | Text alignment |
| lineHeight | 4044 | Line spacing |
| gap | 4045 | Child spacing |
| weight | 4046 | Flex grow |
| flex | 4047 | Flex shorthand |
| verticalAlignment | 4048 | Vertical alignment (main axis for Column, cross axis for Row) |
| horizontalAlignment | 4049 | Horizontal alignment (cross axis for Column, main axis for Row) |
| shadow | 4050 | Box shadow |
| elevation | 4051 | Material elevation |
| blur | 4052 | Blur filter |
| transform | 4053 | CSS transform |
| rotate | 4054 | Rotation |
| scale | 4055 | Scaling |
| transition | 4056 | CSS transitions |
| overflow | 4057 | Overflow handling |
| zIndex | 4058 | Stacking order |
| position | 4059 | Position mode |
| gridColumns | 4060 | Grid columns |
| linearGradient | 4061 | Gradient backgrounds |
| maxLines | 4062 | Text line limit |

## Connecting from Android Emulator

Replace `localhost` with `10.0.2.2`:
```
ws://10.0.2.2:4000
```

## Connecting from Physical Device

Use your machine's local IP address:
```
ws://192.168.x.x:4000
```

## Structure

```
component-gallery-server/
├── server.ts              # Main server file
├── components/            # Component examples
│   ├── column.ts
│   ├── row.ts
│   ├── text.ts
│   └── ...
└── applicators/           # Applicator examples
    ├── padding.ts
    ├── margin.ts
    ├── color.ts
    └── ...
```

## Example File Structure

Each component/applicator file exports a module and UI template:

```typescript
import { app } from "../../hypen-web/packages/core/src/index.ts";

export const exampleExample = {
  module: app.defineState({ ... }).build(),
  ui: `
    Column {
      Text("Example")
    }
  `
};
```
