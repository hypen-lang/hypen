import SwiftUI

// MARK: - Input Component

public struct InputComponent: ComponentHandler {
    public let typeName = "input"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let placeholder = context.element.getStringProp("placeholder.0")
            ?? context.element.getStringProp("placeholder")
            ?? ""

        let initialValue = context.element.getStringProp("value.0")
            ?? context.element.getStringProp("value")
            ?? ""

        let inputType = context.element.getStringProp("type.0")
            ?? context.element.getStringProp("type")
            ?? "text"

        let onInput = ActionValue.from(context.element.props["onInput.0"])
        let onChange = ActionValue.from(context.element.props["onChange.0"])
        let bindPath = context.element.getStringProp("bind")

        return AnyView(
            InputViewWrapper(
                placeholder: placeholder,
                initialValue: initialValue,
                inputType: inputType,
                modifier: modifier,
                onInput: onInput,
                onChange: onChange,
                bindPath: bindPath,
                actionDispatcher: context.actionDispatcher
            )
        )
    }
}

private struct InputViewWrapper: View {
    let placeholder: String
    let initialValue: String
    let inputType: String
    let modifier: HypenModifier
    let onInput: ActionValue?
    let onChange: ActionValue?
    let bindPath: String?
    let actionDispatcher: ActionDispatcher

    @State private var text: String
    @State private var isSyncingFromProps = false

    init(
        placeholder: String,
        initialValue: String,
        inputType: String,
        modifier: HypenModifier,
        onInput: ActionValue?,
        onChange: ActionValue?,
        bindPath: String?,
        actionDispatcher: ActionDispatcher
    ) {
        self.placeholder = placeholder
        self.initialValue = initialValue
        self.inputType = inputType
        self.modifier = modifier
        self.onInput = onInput
        self.onChange = onChange
        self.bindPath = bindPath
        self.actionDispatcher = actionDispatcher
        self._text = State(initialValue: initialValue)
    }

    var body: some View {
        Group {
            if inputType == "password" {
                SecureField(placeholder, text: $text)
                    #if os(iOS)
                    .keyboardType(keyboardType)
                    #endif
            } else {
                TextField(placeholder, text: $text)
                    #if os(iOS)
                    .keyboardType(keyboardType)
                    #endif
            }
        }
        .textFieldStyle(.plain)
        .onChangeCompat(of: text) { newValue in
            if isSyncingFromProps {
                isSyncingFromProps = false
                return
            }
            dispatchInput(newValue)
        }
        .onChangeCompat(of: initialValue) { newValue in
            guard newValue != text else { return }
            isSyncingFromProps = true
            text = newValue
        }
        .hypenModifier(modifier)
    }

    #if os(iOS)
    private var keyboardType: UIKeyboardType {
        switch inputType {
        case "email": return .emailAddress
        case "number": return .numberPad
        case "phone", "tel": return .phonePad
        case "url": return .URL
        default: return .default
        }
    }
    #endif

    private func dispatchInput(_ value: String) {
        if let onInput = onInput {
            var payload = onInput.payload
            payload["value"] = value
            payload["type"] = "input"
            payload["timestamp"] = Date().timeIntervalSince1970 * 1000
            actionDispatcher.dispatch(action: onInput.actionName, payload: payload)
        }
        if let onChange = onChange {
            var payload = onChange.payload
            payload["value"] = value
            payload["type"] = "change"
            payload["timestamp"] = Date().timeIntervalSince1970 * 1000
            actionDispatcher.dispatch(action: onChange.actionName, payload: payload)
        }

        // Dispatch __hypen_bind for two-way binding
        if let bindPath = bindPath {
            actionDispatcher.dispatch(action: "__hypen_bind", payload: [
                "path": bindPath,
                "value": value,
            ])
        }
    }
}

// MARK: - TextArea Component

public struct TextAreaComponent: ComponentHandler {
    public let typeName = "textarea"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let placeholder = context.element.getStringProp("placeholder.0")
            ?? context.element.getStringProp("placeholder")
            ?? ""

        let initialValue = context.element.getStringProp("value.0")
            ?? context.element.getStringProp("value")
            ?? ""

        let onInput = ActionValue.from(context.element.props["onInput.0"])
            ?? ActionValue.from(context.element.props["onInput"])
        let onChange = ActionValue.from(context.element.props["onChange.0"])
            ?? ActionValue.from(context.element.props["onChange"])
        let bindPath = context.element.getStringProp("bind")

        return AnyView(
            TextAreaViewWrapper(
                placeholder: placeholder,
                initialValue: initialValue,
                modifier: modifier,
                onInput: onInput,
                onChange: onChange,
                bindPath: bindPath,
                actionDispatcher: context.actionDispatcher
            )
        )
    }
}

private struct TextAreaViewWrapper: View {
    let placeholder: String
    let initialValue: String
    let modifier: HypenModifier
    let onInput: ActionValue?
    let onChange: ActionValue?
    let bindPath: String?
    let actionDispatcher: ActionDispatcher

    @State private var text: String
    @State private var isSyncingFromProps = false

    init(
        placeholder: String,
        initialValue: String,
        modifier: HypenModifier,
        onInput: ActionValue?,
        onChange: ActionValue?,
        bindPath: String?,
        actionDispatcher: ActionDispatcher
    ) {
        self.placeholder = placeholder
        self.initialValue = initialValue
        self.modifier = modifier
        self.onInput = onInput
        self.onChange = onChange
        self.bindPath = bindPath
        self.actionDispatcher = actionDispatcher
        self._text = State(initialValue: initialValue)
    }

    var body: some View {
        TextEditor(text: $text)
            .onChangeCompat(of: text) { newValue in
                if isSyncingFromProps {
                    isSyncingFromProps = false
                    return
                }
                dispatchInput(newValue)
            }
            .onChangeCompat(of: initialValue) { newValue in
                guard newValue != text else { return }
                isSyncingFromProps = true
                text = newValue
            }
            .hypenModifier(modifier)
    }

    private func dispatchInput(_ value: String) {
        if let onInput = onInput {
            var payload = onInput.payload
            payload["value"] = value
            payload["type"] = "input"
            payload["timestamp"] = Date().timeIntervalSince1970 * 1000
            actionDispatcher.dispatch(action: onInput.actionName, payload: payload)
        }
        if let onChange = onChange {
            var payload = onChange.payload
            payload["value"] = value
            payload["type"] = "change"
            payload["timestamp"] = Date().timeIntervalSince1970 * 1000
            actionDispatcher.dispatch(action: onChange.actionName, payload: payload)
        }

        // Dispatch __hypen_bind for two-way binding
        if let bindPath = bindPath {
            actionDispatcher.dispatch(action: "__hypen_bind", payload: [
                "path": bindPath,
                "value": value,
            ])
        }
    }
}

// MARK: - Checkbox Component

public struct CheckboxComponent: ComponentHandler {
    public let typeName = "checkbox"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let initialChecked = context.element.getBoolProp("checked.0")
            ?? context.element.getBoolProp("checked")
            ?? false

        let onChange = ActionValue.from(context.element.props["onChange.0"])
        let disabled = context.element.getBoolProp("disabled.0") ?? false
        let bindPath = context.element.getStringProp("bind")

        return AnyView(
            CheckboxViewWrapper(
                initialChecked: initialChecked,
                disabled: disabled,
                modifier: modifier,
                onChange: onChange,
                bindPath: bindPath,
                actionDispatcher: context.actionDispatcher,
                children: children
            )
        )
    }
}

/// Custom checkbox style that renders as a checkbox (not a switch) to match Android/Web
private struct CheckboxToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            // Checkbox box
            ZStack {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(configuration.isOn ? Color.accentColor : Color.gray, lineWidth: 2)
                    .frame(width: 20, height: 20)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(configuration.isOn ? Color.accentColor : Color.clear)
                    )

                if configuration.isOn {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.white)
                }
            }
            .onTapGesture {
                configuration.isOn.toggle()
            }

            // Label (children)
            configuration.label
        }
    }
}

private struct CheckboxViewWrapper: View {
    let initialChecked: Bool
    let disabled: Bool
    let modifier: HypenModifier
    let onChange: ActionValue?
    let bindPath: String?
    let actionDispatcher: ActionDispatcher
    let children: () -> AnyView

    @State private var isChecked: Bool
    @State private var isSyncingFromProps = false

    init(
        initialChecked: Bool,
        disabled: Bool,
        modifier: HypenModifier,
        onChange: ActionValue?,
        bindPath: String?,
        actionDispatcher: ActionDispatcher,
        children: @escaping () -> AnyView
    ) {
        self.initialChecked = initialChecked
        self.disabled = disabled
        self.modifier = modifier
        self.onChange = onChange
        self.bindPath = bindPath
        self.actionDispatcher = actionDispatcher
        self.children = children
        self._isChecked = State(initialValue: initialChecked)
    }

    var body: some View {
        Toggle(isOn: $isChecked) {
            children()
        }
        .toggleStyle(CheckboxToggleStyle())
        .disabled(disabled)
        .onChangeCompat(of: isChecked) { newValue in
            if isSyncingFromProps {
                isSyncingFromProps = false
                return
            }
            dispatchChange(newValue)
        }
        .onChangeCompat(of: initialChecked) { newValue in
            guard newValue != isChecked else { return }
            isSyncingFromProps = true
            isChecked = newValue
        }
        .hypenModifier(modifier)
    }

    private func dispatchChange(_ value: Bool) {
        if let onChange = onChange {
            var payload = onChange.payload
            payload["type"] = "change"
            payload["checked"] = value
            payload["value"] = value
            payload["timestamp"] = Date().timeIntervalSince1970 * 1000
            actionDispatcher.dispatch(action: onChange.actionName, payload: payload)
        }

        // Dispatch __hypen_bind for two-way binding
        if let bindPath = bindPath {
            actionDispatcher.dispatch(action: "__hypen_bind", payload: [
                "path": bindPath,
                "value": value,
            ])
        }
    }
}

// MARK: - Switch Component

public struct SwitchComponent: ComponentHandler {
    public let typeName = "switch"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let initialOn = context.element.getBoolProp("on.0")
            ?? context.element.getBoolProp("value.0")
            ?? false

        let onChange = ActionValue.from(context.element.props["onChange.0"])
        let disabled = context.element.getBoolProp("disabled.0") ?? false
        let bindPath = context.element.getStringProp("bind")

        return AnyView(
            SwitchViewWrapper(
                initialOn: initialOn,
                disabled: disabled,
                modifier: modifier,
                onChange: onChange,
                bindPath: bindPath,
                actionDispatcher: context.actionDispatcher,
                children: children
            )
        )
    }
}

private struct SwitchViewWrapper: View {
    let initialOn: Bool
    let disabled: Bool
    let modifier: HypenModifier
    let onChange: ActionValue?
    let bindPath: String?
    let actionDispatcher: ActionDispatcher
    let children: () -> AnyView

    @State private var isOn: Bool
    @State private var isSyncingFromProps = false

    init(
        initialOn: Bool,
        disabled: Bool,
        modifier: HypenModifier,
        onChange: ActionValue?,
        bindPath: String?,
        actionDispatcher: ActionDispatcher,
        children: @escaping () -> AnyView
    ) {
        self.initialOn = initialOn
        self.disabled = disabled
        self.modifier = modifier
        self.onChange = onChange
        self.bindPath = bindPath
        self.actionDispatcher = actionDispatcher
        self.children = children
        self._isOn = State(initialValue: initialOn)
    }

    var body: some View {
        Toggle(isOn: $isOn) {
            children()
        }
        .toggleStyle(.switch)
        .disabled(disabled)
        .onChangeCompat(of: isOn) { newValue in
            if isSyncingFromProps {
                isSyncingFromProps = false
                return
            }
            dispatchChange(newValue)
        }
        .onChangeCompat(of: initialOn) { newValue in
            guard newValue != isOn else { return }
            isSyncingFromProps = true
            isOn = newValue
        }
        .hypenModifier(modifier)
    }

    private func dispatchChange(_ value: Bool) {
        if let onChange = onChange {
            var payload = onChange.payload
            payload["type"] = "change"
            payload["checked"] = value
            payload["value"] = value
            payload["timestamp"] = Date().timeIntervalSince1970 * 1000
            actionDispatcher.dispatch(action: onChange.actionName, payload: payload)
        }

        // Dispatch __hypen_bind for two-way binding
        if let bindPath = bindPath {
            actionDispatcher.dispatch(action: "__hypen_bind", payload: [
                "path": bindPath,
                "value": value,
            ])
        }
    }
}

// MARK: - Slider Component

public struct SliderComponent: ComponentHandler {
    public let typeName = "slider"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Check both named args (value) and positional (.0 suffix)
        let initialValue = context.element.getDoubleProp("value")
            ?? context.element.getDoubleProp("value.0")
            ?? 0
        let minValue = context.element.getDoubleProp("min")
            ?? context.element.getDoubleProp("min.0")
            ?? 0
        let maxValue = context.element.getDoubleProp("max")
            ?? context.element.getDoubleProp("max.0")
            ?? 100
        let step = context.element.getDoubleProp("step")
            ?? context.element.getDoubleProp("step.0")
        let onChange = ActionValue.from(context.element.props["onChange"])
            ?? ActionValue.from(context.element.props["onChange.0"])
            ?? ActionValue.from(context.element.props["onInput"])
            ?? ActionValue.from(context.element.props["onInput.0"])
        let disabled = context.element.getBoolProp("disabled")
            ?? context.element.getBoolProp("disabled.0")
            ?? false
        let bindPath = context.element.getStringProp("bind.0")
            ?? context.element.getStringProp("bind")

        return AnyView(
            SliderViewWrapper(
                initialValue: initialValue,
                minValue: minValue,
                maxValue: maxValue,
                step: step,
                disabled: disabled,
                modifier: modifier,
                onChange: onChange,
                bindPath: bindPath,
                actionDispatcher: context.actionDispatcher
            )
        )
    }
}

private struct SliderViewWrapper: View {
    let initialValue: Double
    let minValue: Double
    let maxValue: Double
    let step: Double?
    let disabled: Bool
    let modifier: HypenModifier
    let onChange: ActionValue?
    let bindPath: String?
    let actionDispatcher: ActionDispatcher

    @State private var value: Double
    @State private var isSyncingFromProps = false

    init(
        initialValue: Double,
        minValue: Double,
        maxValue: Double,
        step: Double?,
        disabled: Bool,
        modifier: HypenModifier,
        onChange: ActionValue?,
        bindPath: String?,
        actionDispatcher: ActionDispatcher
    ) {
        self.initialValue = initialValue
        self.minValue = minValue
        self.maxValue = maxValue
        self.step = step
        self.disabled = disabled
        self.modifier = modifier
        self.onChange = onChange
        self.bindPath = bindPath
        self.actionDispatcher = actionDispatcher
        self._value = State(initialValue: initialValue)
    }

    var body: some View {
        Group {
            if let step = step {
                Slider(value: $value, in: minValue...maxValue, step: step)
            } else {
                Slider(value: $value, in: minValue...maxValue)
            }
        }
        .disabled(disabled)
        .onChangeCompat(of: value) { newValue in
            if isSyncingFromProps {
                isSyncingFromProps = false
                return
            }
            dispatchChange(newValue)
        }
        .onChangeCompat(of: initialValue) { newValue in
            guard newValue != value else { return }
            isSyncingFromProps = true
            value = newValue
        }
        .hypenModifier(modifier)
    }

    private func dispatchChange(_ value: Double) {
        if let onChange = onChange {
            var payload = onChange.payload
            payload["type"] = "change"
            payload["value"] = value
            payload["timestamp"] = Date().timeIntervalSince1970 * 1000
            actionDispatcher.dispatch(action: onChange.actionName, payload: payload)
        }

        // Dispatch __hypen_bind for two-way binding
        if let bindPath = bindPath {
            actionDispatcher.dispatch(action: "__hypen_bind", payload: [
                "path": bindPath,
                "value": value,
            ])
        }
    }
}

// MARK: - Select Component

public struct SelectComponent: ComponentHandler {
    public let typeName = "select"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let options = context.element.props["options.0"] as? [[String: Any]]
            ?? context.element.props["options"] as? [[String: Any]]
            ?? []

        let initialValue = context.element.getStringProp("value.0")
            ?? context.element.getStringProp("value")

        let onChange = ActionValue.from(context.element.props["onChange.0"])
        let disabled = context.element.getBoolProp("disabled.0") ?? false
        let placeholder = context.element.getStringProp("placeholder.0") ?? "Select..."
        let bindPath = context.element.getStringProp("bind")

        return AnyView(
            SelectViewWrapper(
                options: options,
                initialValue: initialValue,
                placeholder: placeholder,
                disabled: disabled,
                modifier: modifier,
                onChange: onChange,
                bindPath: bindPath,
                actionDispatcher: context.actionDispatcher
            )
        )
    }
}

private struct SelectViewWrapper: View {
    let options: [[String: Any]]
    let initialValue: String?
    let placeholder: String
    let disabled: Bool
    let modifier: HypenModifier
    let onChange: ActionValue?
    let bindPath: String?
    let actionDispatcher: ActionDispatcher

    @State private var selectedValue: String
    @State private var isSyncingFromProps = false

    init(
        options: [[String: Any]],
        initialValue: String?,
        placeholder: String,
        disabled: Bool,
        modifier: HypenModifier,
        onChange: ActionValue?,
        bindPath: String?,
        actionDispatcher: ActionDispatcher
    ) {
        self.options = options
        self.initialValue = initialValue
        self.placeholder = placeholder
        self.disabled = disabled
        self.modifier = modifier
        self.onChange = onChange
        self.bindPath = bindPath
        self.actionDispatcher = actionDispatcher
        self._selectedValue = State(initialValue: initialValue ?? "")
    }

    var body: some View {
        Picker(placeholder, selection: $selectedValue) {
            Text(placeholder).tag("")
            ForEach(options.indices, id: \.self) { index in
                let option = options[index]
                let value = option["value"] as? String ?? ""
                let label = option["label"] as? String ?? value
                Text(label).tag(value)
            }
        }
        .pickerStyle(.menu)
        .disabled(disabled)
        .onChangeCompat(of: selectedValue) { newValue in
            if isSyncingFromProps {
                isSyncingFromProps = false
                return
            }
            dispatchChange(newValue)
        }
        .onChangeCompat(of: initialValue) { newValue in
            let resolved = newValue ?? ""
            guard resolved != selectedValue else { return }
            isSyncingFromProps = true
            selectedValue = resolved
        }
        .hypenModifier(modifier)
    }

    private func dispatchChange(_ value: String) {
        if let onChange = onChange {
            var payload = onChange.payload
            payload["type"] = "change"
            payload["value"] = value
            payload["timestamp"] = Date().timeIntervalSince1970 * 1000
            actionDispatcher.dispatch(action: onChange.actionName, payload: payload)
        }

        // Dispatch __hypen_bind for two-way binding
        if let bindPath = bindPath {
            actionDispatcher.dispatch(action: "__hypen_bind", payload: [
                "path": bindPath,
                "value": value,
            ])
        }
    }
}
