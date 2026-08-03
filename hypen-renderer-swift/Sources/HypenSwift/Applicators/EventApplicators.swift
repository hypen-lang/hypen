import SwiftUI

// NOTE: Event closures built here are memoized on the element via
// `HypenElement.cachedApplicatorResult`. They must capture only the
// action dispatcher — never the `ApplicatorContext`, which strongly
// holds the element. Capturing the context would create a retain cycle
// (element → cached result → closure → context → element) that leaks
// every interactive element after removal.

// MARK: - OnClick Applicator

public struct OnClickApplicator: ApplicatorHandler {
    public let name = "onclick"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let action = ActionValue.from(value) {
            let dispatcher = context.actionDispatcher
            modifier.onTap = {
                dispatcher.dispatch(action: action.actionName, payload: action.payload)
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
            let dispatcher = context.actionDispatcher
            modifier.onTap = {
                dispatcher.dispatch(action: action.actionName, payload: action.payload)
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
            let dispatcher = context.actionDispatcher
            modifier.onLongPress = {
                dispatcher.dispatch(action: action.actionName, payload: action.payload)
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
            let dispatcher = context.actionDispatcher
            modifier.onLongPress = {
                dispatcher.dispatch(action: action.actionName, payload: action.payload)
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
            let dispatcher = context.actionDispatcher
            modifier.onFocus = {
                var payload = action.payload
                payload["type"] = "focus"
                payload["timestamp"] = Int(Date().timeIntervalSince1970 * 1000)
                dispatcher.dispatch(action: action.actionName, payload: payload)
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
            let dispatcher = context.actionDispatcher
            modifier.onBlur = {
                var payload = action.payload
                payload["type"] = "blur"
                payload["timestamp"] = Int(Date().timeIntervalSince1970 * 1000)
                dispatcher.dispatch(action: action.actionName, payload: payload)
            }
        }
    }
}
