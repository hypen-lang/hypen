# Media Components

Components for displaying images, videos, and audio content.

## Image

Image display component.

**Props:**
- `src` (String) or first positional argument: Image URL
- `alt` (String): Alternative text for accessibility
- `url` (String): Alias for `src`

**Example:**
```hypen
Image(src: "photo.jpg", alt: "A beautiful landscape")
```

**Responsive Image:**
```hypen
Image("hero-image.jpg")
  .width("100%")
  .height("auto")
  .objectFit("cover")
  .borderRadius(8)
```

**Avatar-style Image:**
```hypen
Image(src: @{state.user.profilePic})
  .width(50)
  .height(50)
  .borderRadius("50%")
  .objectFit("cover")
```

**With Aspect Ratio:**
```hypen
Image("thumbnail.jpg")
  .width("100%")
  .aspectRatio("16 / 9")
  .objectFit("cover")
```

**Rendered as:** `<img>`

---

## Video

Video player component.

**Props:**
- `src` (String) or first positional argument: Video source URL
- `controls` (Boolean): Show video controls (default: false)
- `autoplay` (Boolean): Auto-play video (default: false)
- `loop` (Boolean): Loop video (default: false)
- `muted` (Boolean): Mute audio (default: false)
- `poster` (String): Poster image URL shown before playback

**Example:**
```hypen
Video(
  src: "intro.mp4",
  controls: true,
  poster: "thumbnail.jpg"
)
```

**Auto-playing Background Video:**
```hypen
Video("background.mp4")
  .autoplay(true)
  .loop(true)
  .muted(true)
  .width("100%")
  .height("100%")
  .objectFit("cover")
```

**Styled Video Player:**
```hypen
Video(src: @{state.videoUrl})
  .width("100%")
  .maxWidth(800)
  .borderRadius(8)
  .boxShadow("0 4px 6px rgba(0,0,0,0.1)")
  .controls(true)
```

**Rendered as:** `<video>`

---

## Audio

Audio player component.

**Props:**
- `src` (String) or first positional argument: Audio source URL
- `controls` (Boolean): Show audio controls (default: false)
- `autoplay` (Boolean): Auto-play audio (default: false)
- `loop` (Boolean): Loop audio (default: false)
- `muted` (Boolean): Mute audio (default: false)

**Example:**
```hypen
Audio(
  src: "podcast.mp3",
  controls: true
)
```

**Background Music:**
```hypen
Audio("ambient-music.mp3")
  .autoplay(true)
  .loop(true)
  .volume(0.3)
```

**Rendered as:** `<audio>`

---

## Media Patterns

### Image Gallery
```hypen
Grid(columns: 3, gap: 16) {
  ForEach(items: @{state.photos}) {
    Image(src: @{item.url})
      .width("100%")
      .aspectRatio("1")
      .objectFit("cover")
      .borderRadius(8)
      .cursor("pointer")
      .onClick(@actions.openPhoto(@{item.id}))
  }
}
```

### Hero Image with Overlay
```hypen
Stack {
  Image("hero-background.jpg")
    .width("100%")
    .height(400)
    .objectFit("cover")
  
  Column()
    .position("absolute")
    .top(0)
    .left(0)
    .width("100%")
    .height("100%")
    .verticalAlignment("center")
    .horizontalAlignment("center")
    .backgroundColor("rgba(0,0,0,0.4)") {
    
    Heading(level: 1, "Welcome")
      .color("#fff")
      .fontSize(48)
      .textShadow("2px 2px 4px rgba(0,0,0,0.5)")
  }
}
```

### Responsive Video Container
```hypen
Container()
  .position("relative")
  .width("100%")
  .paddingBottom("56.25%") {  // 16:9 aspect ratio
  
  Video(src: "video.mp4")
    .position("absolute")
    .top(0)
    .left(0)
    .width("100%")
    .height("100%")
    .controls(true)
}
```

### Image Card
```hypen
Card()
  .overflow("hidden") {
  
  Image(src: @{item.thumbnail})
    .width("100%")
    .height(200)
    .objectFit("cover")
  
  Column()
    .padding(16)
    .gap(8) {
    
    Heading(level: 3, @{item.title})
    Text(@{item.description})
      .fontSize(14)
      .color("#666")
  }
}
```

### Lazy-loaded Image
```hypen
Image(src: @{item.image})
  .width("100%")
  .loading("lazy")  // Browser native lazy loading
  .backgroundColor("#f0f0f0")  // Placeholder color
```

### Image with Caption
```hypen
Column().gap(8) {
  Image(src: "photo.jpg", alt: "Mountain landscape")
    .width("100%")
    .borderRadius(8)
  
  Text("Beautiful mountain view at sunset")
    .fontSize(14)
    .color("#666")
    .textAlign("center")
}
```

### Audio Player UI
```hypen
Row()
  .padding(16)
  .backgroundColor("#f5f5f5")
  .borderRadius(8)
  .verticalAlignment("center")
  .gap(12) {

  Button("▶")
    .width(40)
    .height(40)
    .borderRadius("50%")
    .onClick(@actions.togglePlay)
  
  Column()
    .flex(1)
    .gap(4) {
    
    Text(@{state.songTitle})
      .fontWeight("600")
    
    Text(@{state.artist})
      .fontSize(14)
      .color("#666")
  }
  
  Audio(src: @{state.audioUrl})
    .display("none")
}
```

### Video Thumbnail Grid
```hypen
Grid(columns: 2, gap: 16) {
  ForEach(items: @{state.videos}) {
    Container()
      .position("relative")
      .cursor("pointer")
      .onClick(@actions.playVideo(@{item.id})) {
      
      Image(src: @{item.thumbnail})
        .width("100%")
        .aspectRatio("16 / 9")
        .objectFit("cover")
        .borderRadius(8)
      
      Container()
        .position("absolute")
        .top("50%")
        .left("50%")
        .transform("translate(-50%, -50%)")
        .width(60)
        .height(60)
        .borderRadius("50%")
        .backgroundColor("rgba(0,0,0,0.7)") {
        
        Text("▶")
          .color("#fff")
          .fontSize(24)
      }
    }
  }
}
```

## Image Optimization Tips

1. **Use appropriate formats:** 
   - JPEG for photos
   - PNG for graphics with transparency
   - WebP for better compression (with fallback)
   - SVG for icons and logos

2. **Responsive images:** Use `objectFit` and `aspectRatio` to maintain proportions

3. **Alt text:** Always provide descriptive alt text for accessibility

4. **Loading:** Consider lazy loading for images below the fold

5. **Size optimization:** Serve appropriately sized images for viewport

## Video Best Practices

1. **Provide controls:** Always enable controls unless it's a background video

2. **Accessibility:** Include captions/subtitles when possible

3. **Autoplay:** Only autoplay muted videos (browsers block autoplaying with sound)

4. **Formats:** Provide multiple formats (MP4, WebM) for browser compatibility

5. **Poster images:** Always provide a poster image for better UX

## See Also
- [Size Applicators](../applicators/size.md) - Width, height, aspect ratio
- [Display Applicators](../applicators/display.md) - Object-fit, object-position
- [Effects Applicators](../applicators/effects.md) - Filters and visual effects


