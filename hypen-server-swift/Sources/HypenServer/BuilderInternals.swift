//
//  BuilderInternals.swift
//  HypenServer
//
//  Shared internal helpers used by both `AppBuilder` (untyped / map-state) and
//  `TypedBuilder` (typed / Codable-state). These two builders stay as two
//  distinct public APIs — they're a deliberate product axis, not a duplication
//  to collapse. But any byte-identical private helper between them lives here
//  so the next auditor doesn't mistake equal line counts for a merge target.
//

import Foundation

enum BuilderInternals {
    /// Deserialize a payload from `Any?` (typically a JSON dictionary decoded
    /// from the wire) into a `Codable` type `P`.
    ///
    /// - If `payload` is already `P`, returns it directly.
    /// - If `payload` is `Data`, decodes as JSON directly.
    /// - Otherwise, round-trips via `JSONSerialization` → `JSONDecoder`.
    /// - Returns `nil` on any decode failure (callers treat missing payload as
    ///   "action was dispatched without an intelligible payload").
    static func deserializePayload<P: Codable>(_ payload: Any?, as type: P.Type) -> P? {
        guard let payload = payload else { return nil }

        // If it's already the right type, return it
        if let typed = payload as? P { return typed }

        // Try JSON round-trip
        do {
            let data: Data
            if let jsonData = payload as? Data {
                data = jsonData
            } else {
                data = try JSONSerialization.data(withJSONObject: payload)
            }
            return try JSONDecoder().decode(P.self, from: data)
        } catch {
            return nil
        }
    }
}
