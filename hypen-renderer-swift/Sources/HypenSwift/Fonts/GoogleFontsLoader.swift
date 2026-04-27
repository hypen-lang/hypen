import SwiftUI
import CoreText
#if os(iOS) || os(tvOS) || os(watchOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

private let log = HypenLoggers.fonts

/// Utility for loading Google Fonts at runtime.
///
/// Usage in Hypen DSL:
/// - fontFamily("Roboto") - loads Roboto from Google Fonts
/// - fontFamily("Open Sans") - loads Open Sans from Google Fonts
/// - fontFamily("system") - uses system default
/// - fontFamily("serif") - uses system serif
@MainActor
public class GoogleFontsLoader {
    public static let shared = GoogleFontsLoader()

    private var loadedFonts: Set<String> = []
    private var fontCache: [String: Font] = [:]
    private let queue = DispatchQueue(label: "com.hypenspace.fonts", qos: .userInitiated)

    private init() {}

    // MARK: - Public API

    /// Get a SwiftUI Font for the given font name and size.
    /// If the font is a Google Font, it will be loaded asynchronously.
    /// Falls back to system font if loading fails.
    public func font(name: String, size: CGFloat, weight: Font.Weight = .regular) -> Font {
        // Check if it's a system font keyword
        if let systemFont = systemFontFamily(for: name) {
            return systemFont.weight(weight)
        }

        // Check if font is already loaded
        let cacheKey = "\(name)-\(size)-\(weight)"
        if let cached = fontCache[cacheKey] {
            return cached
        }

        // Try to use the font if already registered
        if loadedFonts.contains(name) || isFontAvailable(name) {
            let font = Font.custom(name, size: size).weight(weight)
            fontCache[cacheKey] = font
            return font
        }

        // Start async loading and return system font for now
        loadGoogleFontAsync(name: name)
        return Font.system(size: size).weight(weight)
    }

    /// Check if a font name is a system font keyword.
    public func isSystemFontKeyword(_ name: String) -> Bool {
        let normalized = name.lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: "_", with: "")

        return ["default", "system", "serif", "sansserif", "sans",
                "monospace", "mono", "courier", "cursive"].contains(normalized)
    }

    /// Get the system font for a keyword.
    public func systemFontFamily(for keyword: String) -> Font? {
        let normalized = keyword.lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: "_", with: "")

        switch normalized {
        case "default", "system":
            return .body
        case "serif":
            return .system(.body, design: .serif)
        case "sansserif", "sans":
            return .system(.body, design: .default)
        case "monospace", "mono", "courier":
            return .system(.body, design: .monospaced)
        case "cursive":
            // iOS doesn't have a cursive system font, use serif as fallback
            return .system(.body, design: .serif)
        default:
            return nil
        }
    }

    // MARK: - Font Loading

    /// Load a Google Font asynchronously.
    private func loadGoogleFontAsync(name: String) {
        guard !loadedFonts.contains(name) else { return }

        Task.detached { [weak self] in
            await self?.downloadAndRegisterFont(name: name)
        }
    }

    /// Download and register a Google Font.
    private func downloadAndRegisterFont(name: String) {
        // Google Fonts API URL format
        let fontNameEncoded = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? name
        let urlString = "https://fonts.googleapis.com/css2?family=\(fontNameEncoded):wght@100;200;300;400;500;600;700;800;900&display=swap"

        guard let cssURL = URL(string: urlString) else {
            log.warn("Invalid URL for font: %@", name)
            return
        }

        // Fetch CSS to get font file URLs
        do {
            let cssContent = try String(contentsOf: cssURL, encoding: .utf8)
            let fontURLs = extractFontURLs(from: cssContent)

            for fontURL in fontURLs {
                if let url = URL(string: fontURL) {
                    registerFontFromURL(url, fontName: name)
                }
            }

            DispatchQueue.main.async { [weak self] in
                self?.loadedFonts.insert(name)
                self?.fontCache.removeAll() // Clear cache to use new fonts
            }

            log.debug("Loaded font: %@", name)
        } catch {
            log.warn("Failed to load font '%@': %@", name, error.localizedDescription)
        }
    }

    /// Extract font file URLs from Google Fonts CSS.
    private func extractFontURLs(from css: String) -> [String] {
        var urls: [String] = []

        // Match url(...) patterns
        let pattern = "url\\((https://[^)]+)\\)"
        if let regex = try? NSRegularExpression(pattern: pattern) {
            let range = NSRange(css.startIndex..., in: css)
            let matches = regex.matches(in: css, range: range)

            for match in matches {
                if let urlRange = Range(match.range(at: 1), in: css) {
                    let url = String(css[urlRange])
                    // Prefer woff2 or ttf
                    if url.contains(".woff2") || url.contains(".ttf") {
                        urls.append(url)
                    }
                }
            }
        }

        return urls
    }

    /// Register a font from a URL.
    private func registerFontFromURL(_ url: URL, fontName: String) {
        do {
            let fontData = try Data(contentsOf: url)
            registerFontFromData(fontData, fontName: fontName)
        } catch {
            log.warn("Failed to download font from %@: %@", url.absoluteString, error.localizedDescription)
        }
    }

    /// Register a font from data.
    private func registerFontFromData(_ data: Data, fontName: String) {
        guard let provider = CGDataProvider(data: data as CFData),
              let cgFont = CGFont(provider) else {
            log.warn("Failed to create font from data")
            return
        }

        var error: Unmanaged<CFError>?
        if !CTFontManagerRegisterGraphicsFont(cgFont, &error) {
            if let error = error?.takeRetainedValue() {
                let description = CFErrorCopyDescription(error) as String?
                // Font might already be registered, which is fine
                if !(description?.contains("already registered") ?? false) {
                    log.warn("Failed to register font: %@", description ?? "unknown error")
                }
            }
        }
    }

    /// Check if a font is available on the system.
    private func isFontAvailable(_ fontName: String) -> Bool {
        #if os(iOS) || os(tvOS) || os(watchOS)
        let fontFamilyNames = UIFont.familyNames
        for family in fontFamilyNames {
            if family.lowercased() == fontName.lowercased() {
                return true
            }
            let fontNames = UIFont.fontNames(forFamilyName: family)
            for name in fontNames {
                if name.lowercased().contains(fontName.lowercased()) {
                    return true
                }
            }
        }
        return false
        #elseif os(macOS)
        let fontManager = NSFontManager.shared
        let fontFamilies = fontManager.availableFontFamilies
        for family in fontFamilies {
            if family.lowercased() == fontName.lowercased() {
                return true
            }
            if let members = fontManager.availableMembers(ofFontFamily: family) {
                for member in members {
                    if let name = member.first as? String,
                       name.lowercased().contains(fontName.lowercased()) {
                        return true
                    }
                }
            }
        }
        return false
        #else
        return false
        #endif
    }

    // MARK: - Popular Fonts

    /// List of popular Google Fonts for reference.
    public static let popularFonts = [
        "Roboto",
        "Open Sans",
        "Lato",
        "Montserrat",
        "Poppins",
        "Inter",
        "Nunito",
        "Playfair Display",
        "Merriweather",
        "Source Code Pro",
        "Fira Code",
        "JetBrains Mono",
        "Raleway",
        "Ubuntu",
        "Oswald",
        "Quicksand",
        "Work Sans",
        "Rubik",
        "Karla",
        "DM Sans",
    ]
}
