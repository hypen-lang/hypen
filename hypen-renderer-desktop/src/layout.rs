//! Layout pass via Taffy.
//!
//! Builds a [`TaffyTree`] mirroring the renderer tree, computes flex
//! layout, and walks back to absolute physical-pixel rects. The painter
//! and the hit-tester both consume the resulting [`Vec<LayoutItem>`] so
//! visuals and clicks agree by construction.
//!
//! Element-type → flex direction:
//!
//! - `Row` → row.
//! - `Column` / `Container` / unknown → column.
//!
//! Style props understood (`style.rs` has the full list):
//!
//! - `padding(.0|.top|.right|.bottom|.left|.horizontal|.vertical)` —
//!   container box-model padding.
//! - `gap.0` — flex gap on both axes.
//! - `fontSize.0` — overrides default text size for `Text` leaves.
//! - `color.0`, `backgroundColor.0` — read by the painter, not layout.

use crate::style::{border, margin, padding, prop_color, prop_f32, Border, Rgba};
use crate::text::TextEngine;
use crate::tree::{Tree, ROOT_ID};
use std::collections::HashMap;
use taffy::prelude::*;
use taffy::style::Overflow;

const DEFAULT_GAP_PX: f32 = 8.0;
const DEFAULT_PADDING_PX: f32 = 24.0;
const DEFAULT_BUTTON_PAD_X: f32 = 16.0;
const DEFAULT_BUTTON_PAD_Y: f32 = 10.0;
const DEFAULT_FONT_SIZE_PX: f32 = 18.0;
const DEFAULT_INPUT_MIN_W_PX: f32 = 200.0;
const DEFAULT_INPUT_PAD_X: f32 = 12.0;
const DEFAULT_INPUT_PAD_Y: f32 = 8.0;

/// Element types whose `action` prop is dispatched on click.
pub const ACTIONABLE_TYPES: &[&str] = &["Button", "Link", "Card"];

/// Element types that accept keyboard text input. Phase 7 ships `Input`;
/// `Textarea` will join when multi-line editing lands.
pub const TEXT_INPUT_TYPES: &[&str] = &["Input"];

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

#[derive(Debug, Clone)]
pub enum ItemKind {
    Text {
        content: String,
        font_size: f32,
        color: Rgba,
    },
    Button,
    Container,
    /// Single-line text input. The renderer keeps the live editor state
    /// (cursor, selection) in `App`, keyed by `node_id` — this struct
    /// just carries the resolved value, the placeholder, and the
    /// dotted state-binding path for `__hypen_bind` dispatches.
    Input {
        value: String,
        placeholder: Option<String>,
        bind_path: Option<String>,
        font_size: f32,
        color: Rgba,
    },
}

#[derive(Debug, Clone)]
pub struct LayoutItem {
    pub node_id: String,
    pub kind: ItemKind,
    pub rect: Rect,
    pub action: Option<String>,
    /// Optional fill. Painted under everything else for the same item.
    /// Buttons resolve to a sensible default if no `backgroundColor` was
    /// supplied; containers and text leave it `None` by default.
    pub background: Option<Rgba>,
    /// Border stroke (width + colour + radius). `Border::is_visible()`
    /// is the painter's gate.
    pub border: Border,
}

pub struct LayoutPass {
    pub items: Vec<LayoutItem>,
    /// Tightest bounding box of all emitted items in the layout's
    /// natural (un-scrolled) coordinate space. Used by the window to
    /// clamp the scroll offset.
    pub content_size: (f32, f32),
}

/// Per-Taffy-node sidecar so the measure callback can look up text
/// content and font size without a back-channel into the renderer tree.
#[derive(Debug, Default)]
struct NodeContext {
    text: Option<String>,
    font_size: f32,
}

impl LayoutPass {
    /// Convenience for callers that don't need scrolling — equivalent
    /// to [`Self::compute_with_scroll`] with `scroll_y = 0.0`.
    pub fn compute(
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
    ) -> Self {
        Self::compute_with_scroll(tree, text, viewport, scale, 0.0)
    }

    /// Run a full layout pass with `scroll_y` (physical px) subtracted
    /// from every emitted item's `y` position. Items above the
    /// viewport (negative y) and below it still appear in `items`,
    /// they just paint outside the framebuffer — tiny-skia happily
    /// clips. Hit-testing reads the post-offset rects directly so
    /// scrolled clicks resolve correctly.
    pub fn compute_with_scroll(
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
        scroll_y: f32,
    ) -> Self {
        let mut taffy: TaffyTree<NodeContext> = TaffyTree::new();

        // The synthetic outer container holds top-level page padding and
        // a vertical stack of root children.
        let mut renderer_for_taffy: HashMap<NodeId, String> = HashMap::new();
        let mut root_children = Vec::new();
        for child_id in tree.root_children() {
            if let Some(node_id) =
                build_subtree(&mut taffy, tree, child_id, scale, &mut renderer_for_taffy)
            {
                root_children.push(node_id);
            }
        }

        let pad = DEFAULT_PADDING_PX * scale;
        let outer_style = Style {
            display: Display::Flex,
            flex_direction: FlexDirection::Column,
            padding: Rect_::length(pad),
            gap: Size {
                width: length(DEFAULT_GAP_PX * scale),
                height: length(DEFAULT_GAP_PX * scale),
            },
            size: Size {
                width: length(viewport.0 as f32),
                height: length(viewport.1 as f32),
            },
            ..Default::default()
        };
        let root = taffy
            .new_with_children(outer_style, &root_children)
            .expect("taffy root node");

        let available = Size {
            width: AvailableSpace::Definite(viewport.0 as f32),
            height: AvailableSpace::Definite(viewport.1 as f32),
        };
        let measure = |known: Size<Option<f32>>,
                       avail: Size<AvailableSpace>,
                       _node_id: NodeId,
                       ctx: Option<&mut NodeContext>,
                       _style: &Style|
         -> Size<f32> {
            let Some(ctx) = ctx else {
                return Size::ZERO;
            };
            let Some(text_content) = ctx.text.as_deref() else {
                return Size::ZERO;
            };
            // Wrap to whatever width the parent has told us about. Prefer
            // a known/definite constraint; fall back to the available
            // space if it's bounded; if both are unknown, no wrap.
            let wrap_width = known.width.or(match avail.width {
                AvailableSpace::Definite(w) => Some(w),
                AvailableSpace::MinContent | AvailableSpace::MaxContent => None,
            });
            let (w, h) = text.measure(text_content, ctx.font_size, wrap_width);
            Size {
                width: known.width.unwrap_or(w),
                height: known.height.unwrap_or(h),
            }
        };

        if let Err(e) = taffy.compute_layout_with_measure(root, available, measure) {
            log::warn!("taffy layout failed: {e:?}");
        }

        // Walk and emit absolute-rect items in natural (un-scrolled)
        // coordinates first so we can capture the true content size.
        let mut items = Vec::new();
        emit_items(&taffy, root, 0.0, 0.0, tree, &renderer_for_taffy, &mut items);

        let content_size = items.iter().fold((0.0_f32, 0.0_f32), |(w, h), it| {
            (
                w.max(it.rect.x + it.rect.w),
                h.max(it.rect.y + it.rect.h),
            )
        });

        // Apply scroll. Phase 8 only scrolls the page vertically;
        // horizontal can come when we expose Container::overflow.
        if scroll_y != 0.0 {
            for it in items.iter_mut() {
                it.rect.y -= scroll_y;
            }
        }

        Self {
            items,
            content_size,
        }
    }

    pub fn hit(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        self.items
            .iter()
            .rev()
            .find(|it| it.action.is_some() && it.rect.contains(x, y))
    }

    /// Topmost focusable item under the cursor — actionables OR text
    /// inputs. Used by mouse-down to choose a focus target (clicking
    /// an Input focuses it for typing; clicking a Button focuses *and*
    /// the matching mouse-up dispatches its action).
    pub fn hit_focusable(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        self.items
            .iter()
            .rev()
            .find(|it| it.is_focusable() && it.rect.contains(x, y))
    }

    /// All actionable items in document (paint) order. Used by keyboard
    /// navigation to walk Tab focus through the tree.
    pub fn actionables(&self) -> impl Iterator<Item = &LayoutItem> {
        self.items.iter().filter(|it| it.action.is_some())
    }

    /// All focusable items in document order — actionables + text inputs.
    /// Tab cycles through this list.
    pub fn focusables(&self) -> impl Iterator<Item = &LayoutItem> {
        self.items.iter().filter(|it| it.is_focusable())
    }

    /// Node id of the focusable that follows `current` in document
    /// order. If `current` is `None` or unknown, returns the first
    /// focusable. If `current` is the last, wraps to the first.
    pub fn focus_next(&self, current: Option<&str>) -> Option<String> {
        let ids: Vec<&str> = self.focusables().map(|it| it.node_id.as_str()).collect();
        if ids.is_empty() {
            return None;
        }
        let idx = current
            .and_then(|c| ids.iter().position(|id| *id == c))
            .map(|i| (i + 1) % ids.len())
            .unwrap_or(0);
        Some(ids[idx].to_string())
    }

    /// Node id of the focusable that precedes `current` in document
    /// order. Wraps to the last when `current` is the first.
    pub fn focus_prev(&self, current: Option<&str>) -> Option<String> {
        let ids: Vec<&str> = self.focusables().map(|it| it.node_id.as_str()).collect();
        if ids.is_empty() {
            return None;
        }
        let idx = current
            .and_then(|c| ids.iter().position(|id| *id == c))
            .map(|i| (i + ids.len() - 1) % ids.len())
            .unwrap_or(ids.len() - 1);
        Some(ids[idx].to_string())
    }
}

impl LayoutItem {
    /// True for items that take focus on click / Tab — actionables
    /// (Buttons, Cards, Links) plus text-input elements.
    pub fn is_focusable(&self) -> bool {
        self.action.is_some() || matches!(self.kind, ItemKind::Input { .. })
    }
}

// ---------------------------------------------------------------------------
// Build phase: renderer tree → Taffy tree.
// ---------------------------------------------------------------------------

fn build_subtree(
    taffy: &mut TaffyTree<NodeContext>,
    tree: &Tree,
    node_id: &str,
    scale: f32,
    renderer_for_taffy: &mut HashMap<NodeId, String>,
) -> Option<NodeId> {
    let node = tree.get(node_id)?;

    match node.element_type.as_str() {
        et if TEXT_INPUT_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Inputs are leaf flex nodes with their own padding + a
            // sensible minimum width so they don't collapse to nothing
            // in horizontal layouts.
            let pad_x = DEFAULT_INPUT_PAD_X * scale;
            let pad_y = DEFAULT_INPUT_PAD_Y * scale;
            let style = Style {
                display: Display::Flex,
                min_size: Size {
                    width: length(DEFAULT_INPUT_MIN_W_PX * scale),
                    height: length((DEFAULT_FONT_SIZE_PX * 1.3) * scale + 2.0 * pad_y),
                },
                padding: Rect_ {
                    left: length(pad_x),
                    right: length(pad_x),
                    top: length(pad_y),
                    bottom: length(pad_y),
                },
                margin: margin_to_taffy(margin(node), scale),
                border: border_to_taffy(border(node), scale),
                ..Default::default()
            };
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        "Text" => {
            let font_size = prop_f32(node, "fontSize")
                .map(|v| v * scale)
                .unwrap_or(DEFAULT_FONT_SIZE_PX * scale);
            let content = node.text_content().unwrap_or("").to_string();
            let style = Style {
                display: Display::Flex,
                ..Default::default()
            };
            let id = taffy
                .new_leaf_with_context(
                    style,
                    NodeContext {
                        text: Some(content),
                        font_size,
                    },
                )
                .ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Buttons are flex containers with their own default padding
            // unless overridden by .padding(...).
            let pad = padding(node);
            let pad_x = if pad.left == 0.0 && pad.right == 0.0 {
                DEFAULT_BUTTON_PAD_X
            } else {
                (pad.left + pad.right) * 0.5
            };
            let pad_y = if pad.top == 0.0 && pad.bottom == 0.0 {
                DEFAULT_BUTTON_PAD_Y
            } else {
                (pad.top + pad.bottom) * 0.5
            };
            let style = Style {
                display: Display::Flex,
                flex_direction: FlexDirection::Row,
                align_items: Some(AlignItems::Center),
                justify_content: Some(JustifyContent::Center),
                padding: Rect_ {
                    left: length(pad.left.max(pad_x) * scale),
                    right: length(pad.right.max(pad_x) * scale),
                    top: length(pad.top.max(pad_y) * scale),
                    bottom: length(pad.bottom.max(pad_y) * scale),
                },
                margin: margin_to_taffy(margin(node), scale),
                border: border_to_taffy(border(node), scale),
                gap: Size {
                    width: length(prop_f32(node, "gap").unwrap_or(4.0) * scale),
                    height: length(0.0),
                },
                overflow: taffy::Point {
                    x: Overflow::Visible,
                    y: Overflow::Visible,
                },
                ..Default::default()
            };
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(taffy, tree, child_id, scale, renderer_for_taffy) {
                    children.push(c);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et => {
            let dir = if et.eq_ignore_ascii_case("Row") {
                FlexDirection::Row
            } else {
                FlexDirection::Column
            };
            let pad = padding(node);
            let gap_v = prop_f32(node, "gap").unwrap_or(DEFAULT_GAP_PX) * scale;
            let style = Style {
                display: Display::Flex,
                flex_direction: dir,
                padding: Rect_ {
                    left: length(pad.left * scale),
                    right: length(pad.right * scale),
                    top: length(pad.top * scale),
                    bottom: length(pad.bottom * scale),
                },
                margin: margin_to_taffy(margin(node), scale),
                border: border_to_taffy(border(node), scale),
                gap: Size {
                    width: length(gap_v),
                    height: length(gap_v),
                },
                ..Default::default()
            };
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(taffy, tree, child_id, scale, renderer_for_taffy) {
                    children.push(c);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
    }
}

fn margin_to_taffy(m: crate::style::Padding, scale: f32) -> Rect_<LengthPercentageAuto> {
    Rect_ {
        left: LengthPercentageAuto::length(m.left * scale),
        right: LengthPercentageAuto::length(m.right * scale),
        top: LengthPercentageAuto::length(m.top * scale),
        bottom: LengthPercentageAuto::length(m.bottom * scale),
    }
}

fn border_to_taffy(b: Border, scale: f32) -> Rect_<LengthPercentage> {
    let w = if b.is_visible() { b.width * scale } else { 0.0 };
    Rect_ {
        left: length(w),
        right: length(w),
        top: length(w),
        bottom: length(w),
    }
}

// ---------------------------------------------------------------------------
// Walk phase: Taffy tree → flat absolute-positioned LayoutItem list.
// ---------------------------------------------------------------------------

fn emit_items(
    taffy: &TaffyTree<NodeContext>,
    node_id: NodeId,
    parent_x: f32,
    parent_y: f32,
    tree: &Tree,
    renderer_for_taffy: &HashMap<NodeId, String>,
    out: &mut Vec<LayoutItem>,
) {
    let layout = taffy.layout(node_id).expect("taffy layout");
    let x = parent_x + layout.location.x;
    let y = parent_y + layout.location.y;
    let rect = Rect {
        x,
        y,
        w: layout.size.width,
        h: layout.size.height,
    };

    let renderer_id = renderer_for_taffy.get(&node_id).cloned();
    if let Some(rid) = renderer_id.as_deref() {
        if let Some(node) = tree.get(rid) {
            let action = resolve_action(node);
            let mut item_border = border(node);
            // The DSL says `.borderRadius(8)` even when there's no
            // border line — round the fill anyway. The painter checks
            // `is_visible()` independently before stroking.
            let background_explicit = prop_color(node, "backgroundColor");
            match node.element_type.as_str() {
                et if TEXT_INPUT_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    let value = node
                        .props
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let placeholder = node
                        .props
                        .get("placeholder")
                        .or_else(|| node.props.get("placeholder.0"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let bind_path = node
                        .props
                        .get("bind")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let font_size =
                        prop_f32(node, "fontSize").unwrap_or(DEFAULT_FONT_SIZE_PX);
                    let color = prop_color(node, "color").unwrap_or(Rgba::BLACK);
                    let background = background_explicit.or(Some(Rgba(0xff, 0xff, 0xff, 0xff)));
                    if !item_border.is_visible() {
                        item_border = Border {
                            width: 1.0,
                            color: Rgba(0xc4, 0xcc, 0xd8, 0xff),
                            radius: 8.0,
                        };
                    }
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Input {
                            value,
                            placeholder,
                            bind_path,
                            font_size,
                            color,
                        },
                        rect,
                        action: None,
                        background,
                        border: item_border,
                    });
                }
                "Text" => {
                    let font_size =
                        prop_f32(node, "fontSize").unwrap_or(DEFAULT_FONT_SIZE_PX);
                    let color = prop_color(node, "color").unwrap_or(Rgba::BLACK);
                    let content = node.text_content().unwrap_or("").to_string();
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Text {
                            content,
                            font_size,
                            color,
                        },
                        rect,
                        action,
                        background: background_explicit,
                        border: item_border,
                    });
                }
                et if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    let background = background_explicit
                        .or(Some(Rgba(0xe7, 0xee, 0xff, 0xff)));
                    if !item_border.is_visible() {
                        // Default Button stroke when neither width nor
                        // colour was set — keeps the Phase 3 look.
                        item_border = Border {
                            width: 1.0,
                            color: Rgba(0x4a, 0x6a, 0xd6, 0xff),
                            radius: 8.0,
                        };
                    }
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Button,
                        rect,
                        action,
                        background,
                        border: item_border,
                    });
                }
                _ => {
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Container,
                        rect,
                        action,
                        background: background_explicit,
                        border: item_border,
                    });
                }
            }
        }
    }

    for child in taffy.children(node_id).unwrap_or_default() {
        emit_items(taffy, child, x, y, tree, renderer_for_taffy, out);
    }
}

/// Pull an `@actions.X` reference off `props.action` / `props.onClick`
/// and strip the `@actions.` / `@` prefix. Only checked for actionable
/// element types — the engine resolves `Button("@actions.X")` into
/// `props.action`, so we never need to look at `props["0"]` (and doing
/// so would treat any positional Text content as an action name).
fn resolve_action(node: &crate::tree::Node) -> Option<String> {
    if !ACTIONABLE_TYPES
        .iter()
        .any(|t| t.eq_ignore_ascii_case(&node.element_type))
    {
        return None;
    }
    let raw = node
        .props
        .get("action")
        .or_else(|| node.props.get("onClick"))
        .and_then(|v| v.as_str())?;
    let stripped = raw.strip_prefix('@').unwrap_or(raw);
    Some(stripped.strip_prefix("actions.").unwrap_or(stripped).to_string())
}

// Suppress warning on imports used only in helper paths.
#[allow(dead_code)]
fn _root_anchor() -> &'static str {
    ROOT_ID
}

/// Local alias to avoid clashing with our `Rect` (Taffy's `Rect` is a
/// generic 4-edge container, not a 2D rectangle).
type Rect_<T> = taffy::geometry::Rect<T>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::Tree;
    use hypen_engine::Patch;
    use indexmap::IndexMap;
    use serde_json::{json, Value};
    use std::sync::Arc;

    /// Build a `Patch::Create` with the given props (k/v pairs of `&str` →
    /// `serde_json::Value`).
    fn create_patch(id: &str, element_type: &str, props: &[(&str, Value)]) -> Patch {
        let mut map: IndexMap<String, Value> = IndexMap::new();
        for (k, v) in props {
            map.insert((*k).into(), v.clone());
        }
        Patch::Create {
            id: id.into(),
            element_type: element_type.into(),
            props: Arc::new(map),
        }
    }

    fn insert_patch(parent_id: &str, id: &str) -> Patch {
        Patch::Insert {
            parent_id: parent_id.into(),
            id: id.into(),
            before_id: None,
        }
    }

    /// Convenience: build a Text node with positional content under the given
    /// parent.
    fn add_text(tree: &mut Tree, parent: &str, id: &str, content: &str) {
        tree.apply(&create_patch(id, "Text", &[("0", json!(content))]));
        tree.apply(&insert_patch(parent, id));
    }

    fn find_item<'a>(pass: &'a LayoutPass, node_id: &str) -> &'a LayoutItem {
        pass.items
            .iter()
            .find(|it| it.node_id == node_id)
            .unwrap_or_else(|| panic!("expected layout item for node `{node_id}`"))
    }

    #[test]
    fn column_stacks_two_texts_vertically() {
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        add_text(&mut tree, "col", "t1", "First");
        add_text(&mut tree, "col", "t2", "Second");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let first = find_item(&pass, "t1");
        let second = find_item(&pass, "t2");
        assert!(
            second.rect.y > first.rect.y + first.rect.h - 1.0,
            "expected second text below first; got first={:?} second={:?}",
            first.rect,
            second.rect
        );
    }

    #[test]
    fn row_stacks_two_texts_horizontally() {
        let mut tree = Tree::new();
        tree.apply(&create_patch("row", "Row", &[]));
        tree.apply(&insert_patch("root", "row"));
        add_text(&mut tree, "row", "t1", "First");
        add_text(&mut tree, "row", "t2", "Second");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let first = find_item(&pass, "t1");
        let second = find_item(&pass, "t2");
        assert!(
            second.rect.x > first.rect.x + first.rect.w - 1.0,
            "expected second text to the right of first; got first={:?} second={:?}",
            first.rect,
            second.rect
        );
    }

    #[test]
    fn text_rect_size_is_nonzero() {
        let mut tree = Tree::new();
        add_text(&mut tree, "root", "t1", "Hello");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let item = find_item(&pass, "t1");
        assert!(
            item.rect.w > 0.0 && item.rect.h > 0.0,
            "expected non-zero text rect, got {:?}",
            item.rect
        );
    }

    #[test]
    fn button_emits_button_kind_with_resolved_action() {
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "btn",
            "Button",
            &[("action", json!("@actions.increment"))],
        ));
        tree.apply(&insert_patch("root", "btn"));

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let item = find_item(&pass, "btn");
        assert!(
            matches!(item.kind, ItemKind::Button),
            "expected ItemKind::Button, got {:?}",
            item.kind
        );
        assert_eq!(item.action.as_deref(), Some("increment"));
    }

    #[test]
    fn button_action_strips_at_actions_prefix() {
        let mut tree = Tree::new();
        // Three buttons in a Column so they're all distinct, separately
        // discoverable items.
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        tree.apply(&create_patch(
            "b_full",
            "Button",
            &[("action", json!("@actions.foo"))],
        ));
        tree.apply(&insert_patch("col", "b_full"));
        tree.apply(&create_patch(
            "b_at",
            "Button",
            &[("action", json!("@foo"))],
        ));
        tree.apply(&insert_patch("col", "b_at"));
        tree.apply(&create_patch(
            "b_bare",
            "Button",
            &[("action", json!("foo"))],
        ));
        tree.apply(&insert_patch("col", "b_bare"));

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        for id in ["b_full", "b_at", "b_bare"] {
            let item = find_item(&pass, id);
            assert_eq!(
                item.action.as_deref(),
                Some("foo"),
                "button `{id}` should resolve to action `foo`",
            );
        }
    }

    #[test]
    fn hit_returns_topmost_actionable() {
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        tree.apply(&create_patch(
            "b1",
            "Button",
            &[("action", json!("@actions.first"))],
        ));
        tree.apply(&insert_patch("col", "b1"));
        add_text(&mut tree, "b1", "b1_label", "First");
        tree.apply(&create_patch(
            "b2",
            "Button",
            &[("action", json!("@actions.second"))],
        ));
        tree.apply(&insert_patch("col", "b2"));
        add_text(&mut tree, "b2", "b2_label", "Second");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let second = find_item(&pass, "b2");
        assert!(
            second.rect.w > 0.0 && second.rect.h > 0.0,
            "second button should have a non-zero rect, got {:?}",
            second.rect
        );
        let cx = second.rect.x + second.rect.w / 2.0;
        let cy = second.rect.y + second.rect.h / 2.0;
        let hit = pass.hit(cx, cy).expect("expected a hit at the second button's center");
        assert_eq!(hit.node_id, "b2");
        assert_eq!(hit.action.as_deref(), Some("second"));
    }

    #[test]
    fn text_inside_button_is_not_actionable() {
        // Regression: `resolve_action` used to fall back to `props["0"]`
        // for any element type, so a Text child of a Button (whose
        // content lives at `props["0"]`) ended up flagged actionable
        // and won the hit-test over its parent Button.
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "btn",
            "Button",
            &[("action", json!("@actions.tap"))],
        ));
        tree.apply(&insert_patch("root", "btn"));
        add_text(&mut tree, "btn", "label", "Tap");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let label = find_item(&pass, "label");
        assert!(
            label.action.is_none(),
            "Text content must not be misread as an action",
        );
    }

    #[test]
    fn hit_outside_returns_none() {
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "btn",
            "Button",
            &[("action", json!("@actions.tap"))],
        ));
        tree.apply(&insert_patch("root", "btn"));
        add_text(&mut tree, "btn", "label", "Tap");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        assert!(pass.hit(-1.0, -1.0).is_none());
    }

    #[test]
    fn hit_skips_non_actionable() {
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "box",
            "Container",
            &[("padding.0", json!(40))],
        ));
        tree.apply(&insert_patch("root", "box"));
        add_text(&mut tree, "box", "label", "Just a label");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let container = find_item(&pass, "box");
        // Sanity: container has a non-zero rect we can probe.
        assert!(
            container.rect.w > 0.0 && container.rect.h > 0.0,
            "container should have a non-zero rect from padding, got {:?}",
            container.rect
        );
        assert!(container.action.is_none());

        let cx = container.rect.x + container.rect.w / 2.0;
        let cy = container.rect.y + container.rect.h / 2.0;
        // The container is non-actionable and has no actionable descendants.
        assert!(
            pass.hit(cx, cy).is_none(),
            "hit on non-actionable container should return None",
        );
    }

    #[test]
    fn padding_pushes_first_child_inward() {
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "col",
            "Column",
            &[("padding.0", json!(50))],
        ));
        tree.apply(&insert_patch("root", "col"));
        add_text(&mut tree, "col", "t1", "Padded");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let child = find_item(&pass, "t1");
        assert!(
            child.rect.x >= 50.0,
            "expected child x >= 50 (padding inset), got {}",
            child.rect.x
        );
    }

    // ---------------------------------------------------------------
    // Focus traversal (keyboard navigation)
    // ---------------------------------------------------------------

    fn three_button_layout() -> LayoutPass {
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        for id in ["b1", "b2", "b3"] {
            tree.apply(&create_patch(
                id,
                "Button",
                &[("action", json!(format!("@actions.{id}")))],
            ));
            tree.apply(&insert_patch("col", id));
            add_text(&mut tree, id, &format!("{id}_label"), id);
        }
        let mut text = TextEngine::new();
        LayoutPass::compute(&tree, &mut text, (800, 600), 1.0)
    }

    #[test]
    fn focus_next_starts_at_first_when_none() {
        let pass = three_button_layout();
        assert_eq!(pass.focus_next(None).as_deref(), Some("b1"));
    }

    #[test]
    fn focus_next_walks_in_order_and_wraps() {
        let pass = three_button_layout();
        assert_eq!(pass.focus_next(Some("b1")).as_deref(), Some("b2"));
        assert_eq!(pass.focus_next(Some("b2")).as_deref(), Some("b3"));
        assert_eq!(pass.focus_next(Some("b3")).as_deref(), Some("b1"));
    }

    #[test]
    fn focus_prev_starts_at_last_when_none() {
        let pass = three_button_layout();
        assert_eq!(pass.focus_prev(None).as_deref(), Some("b3"));
    }

    #[test]
    fn focus_prev_walks_backwards_and_wraps() {
        let pass = three_button_layout();
        assert_eq!(pass.focus_prev(Some("b3")).as_deref(), Some("b2"));
        assert_eq!(pass.focus_prev(Some("b2")).as_deref(), Some("b1"));
        assert_eq!(pass.focus_prev(Some("b1")).as_deref(), Some("b3"));
    }

    #[test]
    fn focus_unknown_id_falls_back_to_first_or_last() {
        let pass = three_button_layout();
        assert_eq!(pass.focus_next(Some("ghost")).as_deref(), Some("b1"));
        assert_eq!(pass.focus_prev(Some("ghost")).as_deref(), Some("b3"));
    }

    #[test]
    fn focus_returns_none_when_no_actionables() {
        let mut tree = Tree::new();
        add_text(&mut tree, ROOT_ID, "t", "just text");
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        assert_eq!(pass.focus_next(None), None);
        assert_eq!(pass.focus_prev(None), None);
    }

    #[test]
    fn focus_skips_non_actionable_containers() {
        // Container in the tree should be ignored — only Buttons walk.
        let mut tree = Tree::new();
        tree.apply(&create_patch("box", "Container", &[]));
        tree.apply(&insert_patch("root", "box"));
        tree.apply(&create_patch(
            "btn",
            "Button",
            &[("action", json!("@actions.tap"))],
        ));
        tree.apply(&insert_patch("box", "btn"));
        add_text(&mut tree, "btn", "label", "Tap");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        assert_eq!(pass.focus_next(None).as_deref(), Some("btn"));
        // Walking past the only actionable wraps back to itself.
        assert_eq!(pass.focus_next(Some("btn")).as_deref(), Some("btn"));
    }

    #[test]
    fn border_width_pushes_child_inward_via_taffy() {
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "box",
            "Container",
            &[("borderWidth.0", json!(10))],
        ));
        tree.apply(&insert_patch("root", "box"));
        add_text(&mut tree, "box", "t1", "Inside");

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        let container = find_item(&pass, "box");
        let child = find_item(&pass, "t1");
        assert!(
            child.rect.x >= container.rect.x + 10.0,
            "expected child x ({}) to be at least 10 inside container x ({}); got delta {}",
            child.rect.x,
            container.rect.x,
            child.rect.x - container.rect.x,
        );
    }

    #[test]
    fn text_wraps_to_constrained_width() {
        // A long Text inside a Column constrained to 120px should wrap
        // into multiple lines, growing height beyond a single line.
        let mut tree = Tree::new();
        let long = "the quick brown fox jumps over the lazy dog several times";
        add_text(&mut tree, ROOT_ID, "narrow", long);
        let mut text = TextEngine::new();

        // Wide viewport: text fits on one line, height ≈ one line.
        let wide = LayoutPass::compute(&tree, &mut text, (1200, 600), 1.0);
        let h_wide = find_item(&wide, "narrow").rect.h;

        // Narrow viewport: text wraps, height should be larger.
        let narrow = LayoutPass::compute(&tree, &mut text, (180, 600), 1.0);
        let h_narrow = find_item(&narrow, "narrow").rect.h;

        assert!(
            h_narrow > h_wide,
            "narrow-viewport wrapped height ({h_narrow}) should exceed wide ({h_wide})",
        );
    }

    // ---------------------------------------------------------------
    // Input element
    // ---------------------------------------------------------------

    #[test]
    fn input_emits_input_kind_with_value_placeholder_bind() {
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "in",
            "Input",
            &[
                ("value", json!("hello")),
                ("placeholder", json!("Type here")),
                ("bind", json!("name")),
            ],
        ));
        tree.apply(&insert_patch("root", "in"));
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        let item = find_item(&pass, "in");
        match &item.kind {
            ItemKind::Input {
                value,
                placeholder,
                bind_path,
                ..
            } => {
                assert_eq!(value, "hello");
                assert_eq!(placeholder.as_deref(), Some("Type here"));
                assert_eq!(bind_path.as_deref(), Some("name"));
            }
            other => panic!("expected ItemKind::Input, got {other:?}"),
        }
    }

    #[test]
    fn input_is_focusable_and_walked_by_focus_next() {
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        tree.apply(&create_patch("in", "Input", &[("bind", json!("name"))]));
        tree.apply(&insert_patch("col", "in"));
        tree.apply(&create_patch(
            "btn",
            "Button",
            &[("action", json!("@actions.save"))],
        ));
        tree.apply(&insert_patch("col", "btn"));
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        // First Tab from None → first focusable in document order.
        assert_eq!(pass.focus_next(None).as_deref(), Some("in"));
        // Walk forward from Input → Button.
        assert_eq!(pass.focus_next(Some("in")).as_deref(), Some("btn"));
        // Wrap from last focusable back to first.
        assert_eq!(pass.focus_next(Some("btn")).as_deref(), Some("in"));
    }

    // ---------------------------------------------------------------
    // Scrolling
    // ---------------------------------------------------------------

    #[test]
    fn content_size_grows_with_more_children() {
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        for i in 0..30 {
            let id = format!("t{i}");
            add_text(&mut tree, "col", &id, &format!("row {i}"));
        }
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
        // 30 rows of ~24px line height should comfortably exceed
        // the 200px viewport.
        assert!(
            pass.content_size.1 > 200.0,
            "expected content_size.1 > 200, got {}",
            pass.content_size.1,
        );
    }

    #[test]
    fn compute_with_scroll_shifts_every_item_y() {
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        for i in 0..5 {
            let id = format!("r{i}");
            add_text(&mut tree, "col", &id, &format!("row {i}"));
        }
        let mut text = TextEngine::new();
        let unscrolled = LayoutPass::compute(&tree, &mut text, (400, 600), 1.0);
        let scrolled =
            LayoutPass::compute_with_scroll(&tree, &mut text, (400, 600), 1.0, 100.0);
        for unrolled_item in unscrolled.items.iter() {
            let scrolled_item = find_item(&scrolled, &unrolled_item.node_id);
            let dy = unrolled_item.rect.y - scrolled_item.rect.y;
            assert!(
                (dy - 100.0).abs() < 0.5,
                "item {id} expected -100 shift, got {dy}",
                id = unrolled_item.node_id,
            );
        }
    }

    #[test]
    fn hit_test_still_resolves_under_scroll() {
        // A Button positioned past the natural viewport top should
        // become hittable at the top of the viewport once scrolled.
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        for i in 0..40 {
            let id = format!("r{i}");
            add_text(&mut tree, "col", &id, &format!("filler {i}"));
        }
        tree.apply(&create_patch(
            "btn",
            "Button",
            &[("action", json!("@actions.tap"))],
        ));
        tree.apply(&insert_patch("col", "btn"));
        add_text(&mut tree, "btn", "lbl", "Tap");
        let mut text = TextEngine::new();
        let unscrolled = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
        let btn_natural_y = find_item(&unscrolled, "btn").rect.y;
        // Choose a scroll offset that puts the button into view.
        let scroll_y = btn_natural_y - 50.0;
        let scrolled =
            LayoutPass::compute_with_scroll(&tree, &mut text, (400, 200), 1.0, scroll_y);
        let btn = find_item(&scrolled, "btn");
        let cx = btn.rect.x + btn.rect.w / 2.0;
        let cy = btn.rect.y + btn.rect.h / 2.0;
        let hit = scrolled.hit(cx, cy).expect("button should be hittable after scroll");
        assert_eq!(hit.node_id, "btn");
    }

    #[test]
    fn input_can_be_hit_focused_but_not_action_hit() {
        let mut tree = Tree::new();
        tree.apply(&create_patch("in", "Input", &[("bind", json!("name"))]));
        tree.apply(&insert_patch("root", "in"));
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        let item = find_item(&pass, "in");
        let cx = item.rect.x + item.rect.w / 2.0;
        let cy = item.rect.y + item.rect.h / 2.0;
        assert!(
            pass.hit(cx, cy).is_none(),
            "Input must not be returned by hit() — it has no action",
        );
        let focused = pass
            .hit_focusable(cx, cy)
            .expect("Input should be focus-hittable");
        assert_eq!(focused.node_id, "in");
    }

    // ---------------------------------------------------------------
    // End-to-end round-trip: Patches → Tree → LayoutPass.
    // Lives here (not tree.rs) because it crosses both layers.
    // ---------------------------------------------------------------

    #[test]
    fn patches_to_layout_full_round_trip() {
        // Build a representative tree using the same Patch types the
        // engine emits in production: Create, Insert, SetProp.
        let patches: Vec<Patch> = vec![
            // Root Column.
            create_patch("col", "Column", &[]),
            insert_patch("root", "col"),
            // Plain Text child.
            create_patch("hdr", "Text", &[("0", json!("Welcome"))]),
            insert_patch("col", "hdr"),
            // Button child wired to an action — created without action,
            // SetProp adds it. Exercises the SetProp side of the API.
            create_patch("btn", "Button", &[]),
            insert_patch("col", "btn"),
            Patch::SetProp {
                id: "btn".into(),
                name: "action".into(),
                value: json!("@actions.save"),
            },
            // Input child with a bind path.
            create_patch(
                "in",
                "Input",
                &[
                    ("placeholder", json!("Type here")),
                    ("bind", json!("user.name")),
                ],
            ),
            insert_patch("col", "in"),
        ];

        let mut tree = Tree::new();
        tree.apply_batch(&patches);

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

        // The tree has 4 user nodes (col, hdr, btn, in) + the implicit
        // outer wrapper, so items.len() ≥ 4. Every emitted node above
        // is renderable.
        assert!(
            pass.items.len() >= 4,
            "expected at least 4 layout items (col, hdr, btn, in); got {}",
            pass.items.len(),
        );

        // Button: ItemKind::Button + resolved action stripped of `@actions.`.
        let btn = find_item(&pass, "btn");
        assert!(matches!(btn.kind, ItemKind::Button));
        assert_eq!(btn.action.as_deref(), Some("save"));

        // Input: bind_path matches what we set; placeholder propagated.
        let input = find_item(&pass, "in");
        match &input.kind {
            ItemKind::Input {
                placeholder,
                bind_path,
                ..
            } => {
                assert_eq!(placeholder.as_deref(), Some("Type here"));
                assert_eq!(bind_path.as_deref(), Some("user.name"));
            }
            other => panic!("expected ItemKind::Input for `in`, got {other:?}"),
        }

        // Header text content survived the patch round-trip.
        let hdr = find_item(&pass, "hdr");
        if let ItemKind::Text { content, .. } = &hdr.kind {
            assert_eq!(content, "Welcome");
        } else {
            panic!("expected ItemKind::Text for `hdr`, got {:?}", hdr.kind);
        }

        // Layout produced a non-zero content rect.
        assert!(
            pass.content_size.0 > 0.0 && pass.content_size.1 > 0.0,
            "expected non-zero content_size, got {:?}",
            pass.content_size,
        );
    }
}
