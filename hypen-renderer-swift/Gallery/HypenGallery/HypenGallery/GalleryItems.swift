//
//  GalleryItems.swift
//  HypenGallery
//
//  Component and applicator gallery items matching hypen-renderer-android.
//

import Foundation

/// Represents a component or applicator entry in the gallery.
struct GalleryItem: Identifiable, Hashable {
    let id: String
    let name: String
    let path: String
    let description: String
    let isApplicator: Bool

    init(name: String, path: String, description: String, isApplicator: Bool) {
        self.id = "\(isApplicator ? "applicator" : "component")-\(name)"
        self.name = name
        self.path = path
        self.description = description
        self.isApplicator = isApplicator
    }
}

/// All gallery items for the component gallery server.
/// Single server on port 6555 with path-based routing.
enum GalleryItems {
    static let serverPort = 6555

    /// Use localhost for iOS simulator, or your Mac's IP for device
    #if targetEnvironment(simulator)
    static let serverHost = "localhost"
    #else
    static let serverHost = "localhost" // Change to your Mac's IP for device testing
    #endif

    static let components: [GalleryItem] = [
        GalleryItem(name: "Column", path: "/components/column", description: "Vertical stack container", isApplicator: false),
        GalleryItem(name: "Row", path: "/components/row", description: "Horizontal stack container", isApplicator: false),
        GalleryItem(name: "Text", path: "/components/text", description: "Text display", isApplicator: false),
        GalleryItem(name: "Button", path: "/components/button", description: "Interactive button", isApplicator: false),
        GalleryItem(name: "Image", path: "/components/image", description: "Image display", isApplicator: false),
        GalleryItem(name: "Container", path: "/components/container", description: "Generic container", isApplicator: false),
        GalleryItem(name: "Center", path: "/components/center", description: "Centers content", isApplicator: false),
        GalleryItem(name: "List", path: "/components/list", description: "Scrollable list", isApplicator: false),
        GalleryItem(name: "Input", path: "/components/input", description: "Text input field", isApplicator: false),
        GalleryItem(name: "Link", path: "/components/link", description: "Navigation link", isApplicator: false),
        GalleryItem(name: "TextArea", path: "/components/textarea", description: "Multi-line text input", isApplicator: false),
        GalleryItem(name: "Checkbox", path: "/components/checkbox", description: "Toggle checkbox", isApplicator: false),
        GalleryItem(name: "Select", path: "/components/select", description: "Dropdown selection", isApplicator: false),
        GalleryItem(name: "Spacer", path: "/components/spacer", description: "Flexible space", isApplicator: false),
        GalleryItem(name: "Stack", path: "/components/stack", description: "Overlays children", isApplicator: false),
        GalleryItem(name: "Divider", path: "/components/divider", description: "Visual separator", isApplicator: false),
        GalleryItem(name: "Grid", path: "/components/grid", description: "Grid layout", isApplicator: false),
        GalleryItem(name: "Card", path: "/components/card", description: "Styled card container", isApplicator: false),
        GalleryItem(name: "Heading", path: "/components/heading", description: "Semantic heading", isApplicator: false),
        GalleryItem(name: "Switch", path: "/components/switch", description: "Toggle switch", isApplicator: false),
        GalleryItem(name: "Slider", path: "/components/slider", description: "Range slider", isApplicator: false),
        GalleryItem(name: "Spinner", path: "/components/spinner", description: "Loading indicator", isApplicator: false),
        GalleryItem(name: "Badge", path: "/components/badge", description: "Status badge", isApplicator: false),
        GalleryItem(name: "Avatar", path: "/components/avatar", description: "User avatar", isApplicator: false),
        GalleryItem(name: "ProgressBar", path: "/components/progressbar", description: "Progress indicator", isApplicator: false),
        GalleryItem(name: "Video", path: "/components/video", description: "Video player", isApplicator: false),
        GalleryItem(name: "Audio", path: "/components/audio", description: "Audio player", isApplicator: false),
        GalleryItem(name: "Paragraph", path: "/components/paragraph", description: "Block of text", isApplicator: false),
        GalleryItem(name: "Counter", path: "/components/counter", description: "Interactive counter", isApplicator: false),
        GalleryItem(name: "Calculator", path: "/components/calculator", description: "Functional calculator", isApplicator: false),
        GalleryItem(name: "Onboarding", path: "/components/onboarding", description: "Multi-step onboarding flow", isApplicator: false),
        GalleryItem(name: "Todo", path: "/components/todo", description: "Todo list app", isApplicator: false),
    ]

    static let applicators: [GalleryItem] = [
        GalleryItem(name: "padding", path: "/applicators/padding", description: "Internal spacing", isApplicator: true),
        GalleryItem(name: "margin", path: "/applicators/margin", description: "External spacing", isApplicator: true),
        GalleryItem(name: "color", path: "/applicators/color", description: "Text color", isApplicator: true),
        GalleryItem(name: "backgroundColor", path: "/applicators/backgroundColor", description: "Background color", isApplicator: true),
        GalleryItem(name: "opacity", path: "/applicators/opacity", description: "Transparency", isApplicator: true),
        GalleryItem(name: "width", path: "/applicators/width", description: "Element width", isApplicator: true),
        GalleryItem(name: "height", path: "/applicators/height", description: "Element height", isApplicator: true),
        GalleryItem(name: "size", path: "/applicators/size", description: "Width and height", isApplicator: true),
        GalleryItem(name: "fillMaxSize", path: "/applicators/fillMaxSize", description: "Fill available space", isApplicator: true),
        GalleryItem(name: "border", path: "/applicators/border", description: "Border styling", isApplicator: true),
        GalleryItem(name: "borderRadius", path: "/applicators/borderRadius", description: "Rounded corners", isApplicator: true),
        GalleryItem(name: "cornerRadius", path: "/applicators/cornerRadius", description: "Rounded corners (alias)", isApplicator: true),
        GalleryItem(name: "fontSize", path: "/applicators/fontSize", description: "Text size", isApplicator: true),
        GalleryItem(name: "fontWeight", path: "/applicators/fontWeight", description: "Text weight", isApplicator: true),
        GalleryItem(name: "fontFamily", path: "/applicators/fontFamily", description: "Font family", isApplicator: true),
        GalleryItem(name: "textAlign", path: "/applicators/textAlign", description: "Text alignment", isApplicator: true),
        GalleryItem(name: "lineHeight", path: "/applicators/lineHeight", description: "Line spacing", isApplicator: true),
        GalleryItem(name: "gap", path: "/applicators/gap", description: "Child spacing", isApplicator: true),
        GalleryItem(name: "weight", path: "/applicators/weight", description: "Flex grow", isApplicator: true),
        GalleryItem(name: "flex", path: "/applicators/flex", description: "Flex shorthand", isApplicator: true),
        GalleryItem(name: "verticalAlignment", path: "/applicators/justifyContent", description: "Vertical alignment", isApplicator: true),
        GalleryItem(name: "horizontalAlignment", path: "/applicators/alignItems", description: "Horizontal alignment", isApplicator: true),
        GalleryItem(name: "shadow", path: "/applicators/shadow", description: "Box shadow", isApplicator: true),
        GalleryItem(name: "elevation", path: "/applicators/elevation", description: "Material elevation", isApplicator: true),
        GalleryItem(name: "blur", path: "/applicators/blur", description: "Blur filter", isApplicator: true),
        GalleryItem(name: "transform", path: "/applicators/transform", description: "CSS transform", isApplicator: true),
        GalleryItem(name: "rotate", path: "/applicators/rotate", description: "Rotation", isApplicator: true),
        GalleryItem(name: "scale", path: "/applicators/scale", description: "Scaling", isApplicator: true),
        GalleryItem(name: "transition", path: "/applicators/transition", description: "CSS transitions", isApplicator: true),
        GalleryItem(name: "overflow", path: "/applicators/overflow", description: "Overflow handling", isApplicator: true),
        GalleryItem(name: "zIndex", path: "/applicators/zIndex", description: "Stacking order", isApplicator: true),
        GalleryItem(name: "gridColumns", path: "/applicators/gridColumns", description: "Grid columns", isApplicator: true),
        GalleryItem(name: "linearGradient", path: "/applicators/linearGradient", description: "Gradient backgrounds", isApplicator: true),
        GalleryItem(name: "maxLines", path: "/applicators/maxLines", description: "Text line limit", isApplicator: true),
    ]

    static var all: [GalleryItem] {
        components + applicators
    }

    static func find(byName name: String) -> GalleryItem? {
        all.first { $0.name.lowercased() == name.lowercased() }
    }
}
