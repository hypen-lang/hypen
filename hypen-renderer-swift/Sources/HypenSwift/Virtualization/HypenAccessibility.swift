import Foundation

/// Accessibility strings the renderer speaks for windowed lists
/// (hypen-web/docs/virtualization.md §2), overridable by the host app.
///
/// The defaults are localized from the package's
/// `Resources/<lang>.lproj/Localizable.strings` (en, de, es, fr, it, ja,
/// pt-BR, zh-Hans) with the numbers formatted for `Locale.current`. The
/// language follows the usual bundle rules: the user's preferred languages
/// matched against the package's localizations — and, on Apple platforms,
/// an app that does not itself declare a language keeps package strings in
/// its own development language unless it sets
/// `CFBundleAllowMixedLocalizations`.
///
/// ```swift
/// HypenAccessibility.listPosition = { index, total, isGrid in
///     String(localized: "\(index + 1) of \(total)")
/// }
/// ```
public enum HypenAccessibility {
    /// A materialized row's position in the whole list, read as its
    /// accessibility hint: `(index, total, isGrid)`, `index` zero-based.
    /// Default: "Row 41 of 10,000" / "Item 41 of 10,000", localized.
    @MainActor public static var listPosition: (_ index: Int, _ total: Int, _ isGrid: Bool) -> String = { index, total, isGrid in
        Virtualization.accessibilityPosition(
            index: index, total: total, columns: isGrid ? 2 : 1,
            locale: .current, localize: { localizedFormat($0) }
        )
    }

    /// The windowed list container's accessibility value: `(total, isGrid)`.
    /// Default: "10,000 rows" / "30 items", localized.
    @MainActor public static var listSummary: (_ total: Int, _ isGrid: Bool) -> String = { total, isGrid in
        Virtualization.accessibilitySummary(
            total: total, columns: isGrid ? 2 : 1,
            locale: .current, localize: { localizedFormat($0) }
        )
    }

    /// The translated format for `key` in the language the bundle resolves
    /// for this process; nil when the package has none.
    public static func localizedFormat(_ key: String) -> String? {
        let missing = "\u{0}hypen.missing"
        let value = resourceBundle.localizedString(forKey: key, value: missing, table: nil)
        return value == missing || value == key ? nil : value
    }

    /// The format for `key` in one bundled localization (e.g. "de"); nil
    /// when that localization or key is absent.
    static func format(_ key: String, localization: String) -> String? {
        guard let path = resourceBundle.path(forResource: localization, ofType: "lproj") else { return nil }
        let file = URL(fileURLWithPath: path).appendingPathComponent("Localizable.strings")
        guard let data = try? Data(contentsOf: file),
              let table = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String]
        else { return nil }
        return table[key]
    }

    /// The `.lproj` localizations the package ships.
    static var bundledLocalizations: [String] {
        guard let root = resourceBundle.resourcePath,
              let entries = try? FileManager.default.contentsOfDirectory(atPath: root) else { return [] }
        return entries.filter { $0.hasSuffix(".lproj") }.map { String($0.dropLast(".lproj".count)) }.sorted()
    }

    static var resourceBundle: Bundle { .module }
}
