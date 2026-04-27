// Disambiguation aliases for consumers of this module.
//
// The UniFFI-generated class is named `HypenEngine`, which collides with
// the module name `HypenEngine`. Consumers importing this module cannot
// reliably write `HypenEngine.HypenEngine` because Swift resolves the
// first `HypenEngine` token as the class (shadowing the module), so any
// subsequent member access fails.
//
// These typealiases provide stable, unambiguous names that consumers can
// use instead of fully-qualified references.

public typealias HypenEngineInstance = HypenEngine
public typealias HypenEnginePatch = Patch
public typealias HypenEnginePatchType = PatchType
public typealias HypenEngineModuleConfig = ModuleConfig
public typealias HypenEngineComponentDef = ComponentDef
public typealias HypenEngineAction = Action

/// Alias for the top-level `discoverRouters(source:)` free function so
/// consumers (and our own `NativeEngine.discoverRouters`) can call it
/// without colliding with same-named methods on their own types.
public func _ffiDiscoverRouters(source: String) throws -> String {
    try discoverRouters(source: source)
}
