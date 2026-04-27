import SwiftUI

// MARK: - Rotate Applicator

public struct RotateApplicator: ApplicatorHandler {
    public let name = "rotate"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let degrees = parseDouble(value) {
            modifier.rotation = degrees
            modifier.explicitlySetProperties.insert("rotation")
        }
    }
}

// MARK: - Scale Applicators

public struct ScaleApplicator: ApplicatorHandler {
    public let name = "scale"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let scale = parseCGFloat(value) {
            modifier.scaleX = scale
            modifier.scaleY = scale
            modifier.explicitlySetProperties.formUnion(["scaleX", "scaleY"])
        } else if let dict = value as? [String: Any] {
            if let x = parseCGFloat(dict["x"]) {
                modifier.scaleX = x
                modifier.explicitlySetProperties.insert("scaleX")
            }
            if let y = parseCGFloat(dict["y"]) {
                modifier.scaleY = y
                modifier.explicitlySetProperties.insert("scaleY")
            }
        }
    }
}

public struct ScaleXApplicator: ApplicatorHandler {
    public let name = "scalex"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let scale = parseCGFloat(value) {
            modifier.scaleX = scale
            modifier.explicitlySetProperties.insert("scaleX")
        }
    }
}

public struct ScaleYApplicator: ApplicatorHandler {
    public let name = "scaley"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let scale = parseCGFloat(value) {
            modifier.scaleY = scale
            modifier.explicitlySetProperties.insert("scaleY")
        }
    }
}

// MARK: - Translate Applicators

public struct TranslateXApplicator: ApplicatorHandler {
    public let name = "translatex"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let tx = parseCGFloat(value) {
            modifier.translateX = tx
            modifier.explicitlySetProperties.insert("translateX")
        }
    }
}

public struct TranslateYApplicator: ApplicatorHandler {
    public let name = "translatey"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let ty = parseCGFloat(value) {
            modifier.translateY = ty
            modifier.explicitlySetProperties.insert("translateY")
        }
    }
}

// MARK: - Compound Transform Applicator

/// Applicator for compound transform.
/// Supports object with rotate, scale, translateX, translateY.
public struct TransformApplicator: ApplicatorHandler {
    public let name = "transform"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let dict = value as? [String: Any] else { return }

        if let rotate = parseDouble(dict["rotate"]) {
            modifier.rotation = rotate
            modifier.explicitlySetProperties.insert("rotation")
        }
        if let scale = parseCGFloat(dict["scale"]) {
            modifier.scaleX = scale
            modifier.scaleY = scale
            modifier.explicitlySetProperties.formUnion(["scaleX", "scaleY"])
        }
        if let scaleX = parseCGFloat(dict["scaleX"]) {
            modifier.scaleX = scaleX
            modifier.explicitlySetProperties.insert("scaleX")
        }
        if let scaleY = parseCGFloat(dict["scaleY"]) {
            modifier.scaleY = scaleY
            modifier.explicitlySetProperties.insert("scaleY")
        }
        if let translateX = parseCGFloat(dict["translateX"]) {
            modifier.translateX = translateX
            modifier.explicitlySetProperties.insert("translateX")
        }
        if let translateY = parseCGFloat(dict["translateY"]) {
            modifier.translateY = translateY
            modifier.explicitlySetProperties.insert("translateY")
        }
    }
}

// MARK: - Helpers

fileprivate func parseDouble(_ value: Any?) -> Double? {
    guard let value = value else { return nil }
    if let double = value as? Double { return double }
    if let int = value as? Int { return Double(int) }
    if let str = value as? String {
        let cleaned = str.replacingOccurrences(of: "deg", with: "")
            .replacingOccurrences(of: "°", with: "")
            .trimmingCharacters(in: .whitespaces)
        return Double(cleaned)
    }
    return nil
}

// parseCGFloat is provided by SizeApplicators.swift (public)
