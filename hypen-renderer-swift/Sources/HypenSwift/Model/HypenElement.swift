import Foundation

/// Represents a single element in the Hypen render tree.
///
/// Thread safety is guaranteed by MainActor isolation: `HypenRenderer` is `@MainActor`
/// and all view code that accesses elements runs on MainActor. The `@unchecked Sendable`
/// conformance is safe under this guarantee.
public final class HypenElement: @unchecked Sendable {
    public let id: String
    public let elementType: String
    public var props: [String: Any]
    public var children: [String]
    public var parentId: String?
    public var textContent: String?

    public init(
        id: String,
        elementType: String,
        props: [String: Any] = [:],
        children: [String] = [],
        parentId: String? = nil,
        textContent: String? = nil
    ) {
        self.id = id
        self.elementType = elementType
        self.props = props
        self.children = children
        self.parentId = parentId
        self.textContent = textContent
    }

    // MARK: - Property accessors

    public func getProp<T>(_ name: String) -> T? {
        return props[name] as? T
    }

    public func getStringProp(_ name: String) -> String? {
        if let value = props[name] {
            if let str = value as? String {
                return str
            }
            return String(describing: value)
        }
        return nil
    }

    public func getIntProp(_ name: String) -> Int? {
        if let value = props[name] {
            if let intVal = value as? Int {
                return intVal
            }
            if let doubleVal = value as? Double {
                return Int(doubleVal)
            }
            if let strVal = value as? String, let intVal = Int(strVal) {
                return intVal
            }
        }
        return nil
    }

    public func getDoubleProp(_ name: String) -> Double? {
        if let value = props[name] {
            if let doubleVal = value as? Double {
                return doubleVal
            }
            if let intVal = value as? Int {
                return Double(intVal)
            }
            if let strVal = value as? String, let doubleVal = Double(strVal) {
                return doubleVal
            }
        }
        return nil
    }

    public func getBoolProp(_ name: String) -> Bool? {
        if let value = props[name] {
            if let boolVal = value as? Bool {
                return boolVal
            }
            if let strVal = value as? String {
                return strVal.lowercased() == "true" || strVal == "1"
            }
            if let intVal = value as? Int {
                return intVal != 0
            }
        }
        return nil
    }

    /// Scrollability and (optionally) direction parsed from a single prop.
    ///
    /// The `.scrollable(...)` applicator accepts multiple value shapes to
    /// match the DOM and Compose renderers:
    ///   - `.scrollable(true)` / `.scrollable(false)` — bool
    ///   - `.scrollable("horizontal")` — string direction
    ///   - `.scrollable("vertical")` — string direction
    ///   - `.scrollable("both")` / `.scrollable("auto")` / `.scrollable("scroll")` — both axes
    ///   - `.scrollable("false")` / `.scrollable("none")` / `.scrollable("hidden")` — off
    ///
    /// Returns `(enabled, direction?)`. When `direction` is nil, the caller
    /// should use the component's natural axis (horizontal for Row, vertical
    /// for Column/Grid).
    public enum ScrollAxis {
        case horizontal, vertical, both
    }

    public func getScrollable(_ name: String = "scrollable.0") -> (enabled: Bool, axis: ScrollAxis?) {
        guard let value = props[name] else { return (false, nil) }

        if let boolVal = value as? Bool {
            return (boolVal, nil)
        }
        if let intVal = value as? Int {
            return (intVal != 0, nil)
        }
        if let strVal = value as? String {
            switch strVal.lowercased() {
            case "true", "1", "auto", "scroll", "both":
                return (true, strVal.lowercased() == "both" ? .both : nil)
            case "horizontal":
                return (true, .horizontal)
            case "vertical":
                return (true, .vertical)
            case "false", "0", "none", "hidden", "":
                return (false, nil)
            default:
                return (false, nil)
            }
        }
        return (false, nil)
    }

    public func getCGFloatProp(_ name: String) -> CGFloat? {
        if let double = getDoubleProp(name) {
            return CGFloat(double)
        }
        return nil
    }

    // MARK: - Mutators

    public func setProp(_ name: String, value: Any?) {
        if let value = value {
            props[name] = value
        } else {
            props.removeValue(forKey: name)
        }
    }

    public func addChild(_ childId: String, beforeId: String? = nil) {
        if let beforeId = beforeId, let index = children.firstIndex(of: beforeId) {
            children.insert(childId, at: index)
        } else {
            children.append(childId)
        }
    }

    public func removeChild(_ childId: String) {
        children.removeAll { $0 == childId }
    }
}

extension HypenElement: CustomDebugStringConvertible {
    public var debugDescription: String {
        "HypenElement(id: \(id), type: \(elementType), children: \(children.count))"
    }
}
