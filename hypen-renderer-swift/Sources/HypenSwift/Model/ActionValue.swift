import Foundation

/// Represents an action that can be dispatched from UI elements
public struct ActionValue: @unchecked Sendable {
    public let actionName: String
    public let payload: [String: Any]

    public init(actionName: String, payload: [String: Any] = [:]) {
        self.actionName = actionName
        self.payload = payload
    }

    /// Parse an ActionValue from a property value
    /// Supports formats:
    /// - "@actions.actionName" - full action string (legacy)
    /// - "@actionName" - action string with @ prefix (engine serialization format)
    /// - "actionName" - plain action name
    /// - { "action": "@actions.actionName", "payload": {...} } - action with payload
    /// - { "action": "actionName", ... } - object with action name
    /// - { "0": "@actionName", "key": "val", ... } - grouped applicator format
    public static func from(_ value: Any?) -> ActionValue? {
        guard let value = value else { return nil }

        // Handle simple string format
        if let str = value as? String {
            return ActionValue(actionName: parseActionName(str))
        }

        // Handle dictionary format
        if let dict = value as? [String: Any] {
            // Check for "0" key (grouped applicator format from ApplicatorRegistry)
            // e.g., {"0": "@openUserProfile", "userId": "123"}
            if let zeroValue = dict["0"] {
                if let actionStr = zeroValue as? String {
                    let actionName = parseActionName(actionStr)
                    var payload = dict
                    payload.removeValue(forKey: "0")
                    return ActionValue(actionName: actionName, payload: payload)
                }
            }

            // Check for "action" key
            if let actionStr = dict["action"] as? String {
                let actionName = parseActionName(actionStr)

                // Extract payload (everything except the action key)
                var payload = dict
                payload.removeValue(forKey: "action")

                // Check for explicit payload key
                if let explicitPayload = dict["payload"] as? [String: Any] {
                    return ActionValue(actionName: actionName, payload: explicitPayload)
                }

                return ActionValue(actionName: actionName, payload: payload)
            }

            // Check for "actionName" key (alternative format)
            if let actionNameStr = dict["actionName"] as? String {
                var payload = dict
                payload.removeValue(forKey: "actionName")
                if let explicitPayload = dict["payload"] as? [String: Any] {
                    return ActionValue(actionName: actionNameStr, payload: explicitPayload)
                }
                return ActionValue(actionName: actionNameStr, payload: payload)
            }
        }

        return nil
    }

    /// Parse an action name from a string, stripping @ and actions. prefixes
    private static func parseActionName(_ str: String) -> String {
        if str.hasPrefix("@actions.") {
            return String(str.dropFirst("@actions.".count))
        }
        if str.hasPrefix("@") {
            return String(str.dropFirst(1))
        }
        return str
    }
}

extension ActionValue: Equatable {
    /// Payloads are JSON-shaped (`[String: Any]` of strings, numbers, bools,
    /// arrays and nested objects — they come off the wire or out of props),
    /// so bridged `NSDictionary` equality is well-defined and deep.
    public static func == (lhs: ActionValue, rhs: ActionValue) -> Bool {
        lhs.actionName == rhs.actionName
            && (lhs.payload as NSDictionary).isEqual(to: rhs.payload)
    }
}

extension ActionValue: CustomDebugStringConvertible {
    public var debugDescription: String {
        if payload.isEmpty {
            return "Action(\(actionName))"
        }
        return "Action(\(actionName), payload: \(payload))"
    }
}
