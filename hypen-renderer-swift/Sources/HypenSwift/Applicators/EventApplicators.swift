import SwiftUI

// MARK: - OnClick Applicator

public struct OnClickApplicator: ApplicatorHandler {
    public let name = "onclick"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let action = ActionValue.from(value) {
            modifier.onTap = {
                context.actionDispatcher.dispatch(action: action.actionName, payload: action.payload)
            }
        }
    }
}

// MARK: - OnPress Applicator (alias)

public struct OnPressApplicator: ApplicatorHandler {
    public let name = "onpress"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let action = ActionValue.from(value) {
            modifier.onTap = {
                context.actionDispatcher.dispatch(action: action.actionName, payload: action.payload)
            }
        }
    }
}

// MARK: - OnLongPress Applicator

public struct OnLongPressApplicator: ApplicatorHandler {
    public let name = "onlongpress"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let action = ActionValue.from(value) {
            modifier.onLongPress = {
                context.actionDispatcher.dispatch(action: action.actionName, payload: action.payload)
            }
        }
    }
}

// MARK: - OnLongClick Applicator (alias)

public struct OnLongClickApplicator: ApplicatorHandler {
    public let name = "onlongclick"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let action = ActionValue.from(value) {
            modifier.onLongPress = {
                context.actionDispatcher.dispatch(action: action.actionName, payload: action.payload)
            }
        }
    }
}

// MARK: - OnFocus Applicator

public struct OnFocusApplicator: ApplicatorHandler {
    public let name = "onfocus"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let action = ActionValue.from(value) {
            modifier.onFocus = {
                var payload = action.payload
                payload["type"] = "focus"
                payload["timestamp"] = Int(Date().timeIntervalSince1970 * 1000)
                context.actionDispatcher.dispatch(action: action.actionName, payload: payload)
            }
        }
    }
}

// MARK: - OnBlur Applicator

public struct OnBlurApplicator: ApplicatorHandler {
    public let name = "onblur"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let action = ActionValue.from(value) {
            modifier.onBlur = {
                var payload = action.payload
                payload["type"] = "blur"
                payload["timestamp"] = Int(Date().timeIntervalSince1970 * 1000)
                context.actionDispatcher.dispatch(action: action.actionName, payload: payload)
            }
        }
    }
}
