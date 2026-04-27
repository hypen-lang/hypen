import SwiftUI

// MARK: - Edge Resolution

/// Resolved padding/margin edges in (top, leading, bottom, trailing) form.
private struct Edges {
    let top: CGFloat
    let leading: CGFloat
    let bottom: CGFloat
    let trailing: CGFloat
}

/// Collect contiguous positional applicator args (`"0"`, `"1"`, …) from a
/// grouped value dict. Returns an empty array when no positional args are
/// present (caller falls through to named-keys form).
private func collectPositional(_ dict: [String: Any]) -> [Any] {
    var args: [Any] = []
    var i = 0
    while let v = dict[String(i)] {
        args.append(v)
        i += 1
    }
    return args
}

/// Resolve CSS-shorthand positional edges:
/// - 1 value: all sides
/// - 2 values: vertical, horizontal
/// - 3 values: top, horizontal, bottom
/// - 4 values: top, right, bottom, left
private func edgesFromPositional(_ args: [Any]) -> Edges {
    func cg(_ i: Int) -> CGFloat { parseCGFloat(args.indices.contains(i) ? args[i] : nil) ?? 0 }
    switch args.count {
    case 1:
        let all = cg(0)
        return Edges(top: all, leading: all, bottom: all, trailing: all)
    case 2:
        let v = cg(0), h = cg(1)
        return Edges(top: v, leading: h, bottom: v, trailing: h)
    case 3:
        let t = cg(0), h = cg(1), b = cg(2)
        return Edges(top: t, leading: h, bottom: b, trailing: h)
    default:
        // 4+ values: top, right, bottom, left (CSS shorthand). In LTR/RTL terms
        // right -> trailing, left -> leading.
        let t = cg(0), r = cg(1), b = cg(2), l = cg(3)
        return Edges(top: t, leading: l, bottom: b, trailing: r)
    }
}

/// Resolve named-keys edges (`top`, `bottom`, `left`/`start`/`leading`,
/// `right`/`end`/`trailing`, `horizontal`, `vertical`).
private func edgesFromNamedKeys(_ dict: [String: Any]) -> (top: CGFloat?, leading: CGFloat?, bottom: CGFloat?, trailing: CGFloat?) {
    let top = parseCGFloat(dict["top"]) ?? parseCGFloat(dict["vertical"])
    let bottom = parseCGFloat(dict["bottom"]) ?? parseCGFloat(dict["vertical"])
    let leading = parseCGFloat(dict["leading"])
        ?? parseCGFloat(dict["start"])
        ?? parseCGFloat(dict["left"])
        ?? parseCGFloat(dict["horizontal"])
    let trailing = parseCGFloat(dict["trailing"])
        ?? parseCGFloat(dict["end"])
        ?? parseCGFloat(dict["right"])
        ?? parseCGFloat(dict["horizontal"])
    return (top, leading, bottom, trailing)
}

// MARK: - Padding Applicator

public struct PaddingApplicator: ApplicatorHandler {
    public let name = "padding"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Single all-sides value
        if let all = parseCGFloat(value) {
            modifier.setPadding(all: all)
            modifier.explicitlySetProperties.formUnion(["paddingTop", "paddingBottom", "paddingLeading", "paddingTrailing"])
            return
        }

        guard let dict = value as? [String: Any] else { return }

        // Positional form: padding(v), padding(v,h), padding(t,h,b), padding(t,r,b,l)
        let positional = collectPositional(dict)
        if !positional.isEmpty {
            let edges = edgesFromPositional(positional)
            modifier.paddingTop = edges.top
            modifier.paddingBottom = edges.bottom
            modifier.paddingLeading = edges.leading
            modifier.paddingTrailing = edges.trailing
            modifier.explicitlySetProperties.formUnion([
                "paddingTop", "paddingBottom", "paddingLeading", "paddingTrailing",
            ])
            return
        }

        // Named-keys form
        let (top, leading, bottom, trailing) = edgesFromNamedKeys(dict)
        if let top {
            modifier.paddingTop = top
            modifier.explicitlySetProperties.insert("paddingTop")
        }
        if let bottom {
            modifier.paddingBottom = bottom
            modifier.explicitlySetProperties.insert("paddingBottom")
        }
        if let leading {
            modifier.paddingLeading = leading
            modifier.explicitlySetProperties.insert("paddingLeading")
        }
        if let trailing {
            modifier.paddingTrailing = trailing
            modifier.explicitlySetProperties.insert("paddingTrailing")
        }
    }
}

// MARK: - Margin Applicator

public struct MarginApplicator: ApplicatorHandler {
    public let name = "margin"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Single all-sides value
        if let all = parseCGFloat(value) {
            modifier.setMargin(all: all)
            modifier.explicitlySetProperties.formUnion(["marginTop", "marginBottom", "marginLeading", "marginTrailing"])
            return
        }

        guard let dict = value as? [String: Any] else { return }

        // Positional form: margin(v), margin(v,h), margin(t,h,b), margin(t,r,b,l)
        let positional = collectPositional(dict)
        if !positional.isEmpty {
            let edges = edgesFromPositional(positional)
            modifier.marginTop = edges.top
            modifier.marginBottom = edges.bottom
            modifier.marginLeading = edges.leading
            modifier.marginTrailing = edges.trailing
            modifier.explicitlySetProperties.formUnion([
                "marginTop", "marginBottom", "marginLeading", "marginTrailing",
            ])
            return
        }

        // Named-keys form
        let (top, leading, bottom, trailing) = edgesFromNamedKeys(dict)
        if let top {
            modifier.marginTop = top
            modifier.explicitlySetProperties.insert("marginTop")
        }
        if let bottom {
            modifier.marginBottom = bottom
            modifier.explicitlySetProperties.insert("marginBottom")
        }
        if let leading {
            modifier.marginLeading = leading
            modifier.explicitlySetProperties.insert("marginLeading")
        }
        if let trailing {
            modifier.marginTrailing = trailing
            modifier.explicitlySetProperties.insert("marginTrailing")
        }
    }
}

// MARK: - Directional Padding Applicators

public struct PaddingTopApplicator: ApplicatorHandler {
    public let name = "paddingTop"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) { modifier.paddingTop = v; modifier.explicitlySetProperties.insert("paddingTop") }
    }
}

public struct PaddingBottomApplicator: ApplicatorHandler {
    public let name = "paddingBottom"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) { modifier.paddingBottom = v; modifier.explicitlySetProperties.insert("paddingBottom") }
    }
}

public struct PaddingLeftApplicator: ApplicatorHandler {
    public let name = "paddingLeft"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) { modifier.paddingLeading = v; modifier.explicitlySetProperties.insert("paddingLeading") }
    }
}

public struct PaddingRightApplicator: ApplicatorHandler {
    public let name = "paddingRight"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) { modifier.paddingTrailing = v; modifier.explicitlySetProperties.insert("paddingTrailing") }
    }
}

public struct PaddingHorizontalApplicator: ApplicatorHandler {
    public let name = "paddingHorizontal"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) {
            modifier.paddingLeading = v
            modifier.paddingTrailing = v
            modifier.explicitlySetProperties.formUnion(["paddingLeading", "paddingTrailing"])
        }
    }
}

public struct PaddingVerticalApplicator: ApplicatorHandler {
    public let name = "paddingVertical"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) {
            modifier.paddingTop = v
            modifier.paddingBottom = v
            modifier.explicitlySetProperties.formUnion(["paddingTop", "paddingBottom"])
        }
    }
}

// MARK: - Directional Margin Applicators

public struct MarginTopApplicator: ApplicatorHandler {
    public let name = "marginTop"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) { modifier.marginTop = v; modifier.explicitlySetProperties.insert("marginTop") }
    }
}

public struct MarginBottomApplicator: ApplicatorHandler {
    public let name = "marginBottom"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) { modifier.marginBottom = v; modifier.explicitlySetProperties.insert("marginBottom") }
    }
}

public struct MarginLeftApplicator: ApplicatorHandler {
    public let name = "marginLeft"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) { modifier.marginLeading = v; modifier.explicitlySetProperties.insert("marginLeading") }
    }
}

public struct MarginRightApplicator: ApplicatorHandler {
    public let name = "marginRight"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) { modifier.marginTrailing = v; modifier.explicitlySetProperties.insert("marginTrailing") }
    }
}

public struct MarginHorizontalApplicator: ApplicatorHandler {
    public let name = "marginHorizontal"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) {
            modifier.marginLeading = v
            modifier.marginTrailing = v
            modifier.explicitlySetProperties.formUnion(["marginLeading", "marginTrailing"])
        }
    }
}

public struct MarginVerticalApplicator: ApplicatorHandler {
    public let name = "marginVertical"
    public init() {}
    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let v = parseCGFloat(value) {
            modifier.marginTop = v
            modifier.marginBottom = v
            modifier.explicitlySetProperties.formUnion(["marginTop", "marginBottom"])
        }
    }
}

// parseCGFloat is provided by SizeApplicators.swift (public)
