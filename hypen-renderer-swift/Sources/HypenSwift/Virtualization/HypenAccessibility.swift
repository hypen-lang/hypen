import Foundation

/// Accessibility strings the renderer speaks for windowed lists
/// (hypen-web/docs/virtualization.md §2), overridable by the host app.
///
/// The defaults are localized from the package's
/// `Resources/<lang>.lproj/Localizable.strings` and `Localizable.stringsdict`
/// (CLDR plural categories) — en, de, es, fr, it, ja, pt-BR, zh-Hans — with
/// the numbers formatted for `Locale.current`. The
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
    /// Default: "10,000 rows" / "30 items", localized with the language's
    /// CLDR plural rules (`Localizable.stringsdict`).
    @MainActor public static var listSummary: (_ total: Int, _ isGrid: Bool) -> String = { total, isGrid in
        let language = resolvedLocalization
        return Virtualization.accessibilitySummary(
            total: total, columns: isGrid ? 2 : 1,
            locale: .current, localizePlural: { pluralFormat($0, count: $1, localization: language) }
        )
    }

    /// The translated format for `key` in the language the bundle resolves
    /// for this process; nil when the package has none.
    public static func localizedFormat(_ key: String) -> String? {
        let missing = "\u{0}hypen.missing"
        let value = resourceBundle.localizedString(forKey: key, value: missing, table: nil)
        return value == missing || value == key ? nil : value
    }

    /// The bundled localization the bundle resolves for this process (the
    /// user's preferred languages against the package's), for plurals.
    public static var resolvedLocalization: String {
        resourceBundle.preferredLocalizations.first ?? "en"
    }

    /// The plural variant of `key` for `count` in a bundled localization,
    /// read from its `Localizable.stringsdict` and chosen by the language's
    /// CLDR category (``Virtualization/pluralVariant(_:count:language:)``).
    /// Parsed here rather than through Foundation's stringsdict formatting so
    /// the numbers stay locale-formatted strings and every platform (Linux
    /// included) picks the same variant. Nil when absent.
    public static func pluralFormat(_ key: String, count: Int, localization: String) -> String? {
        Virtualization.pluralVariant(pluralEntry(key, localization: localization), count: count, language: localization)
    }

    /// The raw `.stringsdict` entry for `key` in one bundled localization.
    static func pluralEntry(_ key: String, localization: String) -> Any? {
        table("Localizable.stringsdict", localization: localization)?[key]
    }

    /// The format for `key` in one bundled localization (e.g. "de"); nil
    /// when that localization or key is absent.
    static func format(_ key: String, localization: String) -> String? {
        table("Localizable.strings", localization: localization)?[key] as? String
    }

    /// A property-list table (`.strings` or `.stringsdict`, text or binary)
    /// from `<localization>.lproj`.
    private static func table(_ file: String, localization: String) -> [String: Any]? {
        guard let path = resourceBundle.path(forResource: localization, ofType: "lproj") else { return nil }
        let url = URL(fileURLWithPath: path).appendingPathComponent(file)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    }

    /// The `.lproj` localizations the package ships.
    static var bundledLocalizations: [String] {
        guard let root = resourceBundle.resourcePath,
              let entries = try? FileManager.default.contentsOfDirectory(atPath: root) else { return [] }
        return entries.filter { $0.hasSuffix(".lproj") }.map { String($0.dropLast(".lproj".count)) }.sorted()
    }

    static var resourceBundle: Bundle { .module }
}
