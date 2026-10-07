package space.hypen.core

/**
 * Drag-and-drop names shared with the renderers and the other SDKs
 * (`hypen-web/docs/dnd.md`).
 *
 * Renderers resolve a drop into one of two reserved actions which every
 * [BaseModuleInstance] auto-registers next to `__hypen_bind`:
 *
 * - [REORDER_ACTION] `{fromPath, from, toPath, to}` (or `{path, from, to}`
 *   as shorthand for `fromPath == toPath`) — applied through
 *   [ObservableState.move], i.e. the engine's `portable_path_move`.
 * - [PIN_ACTION] `{path, x, y, xKey?, yKey?}` — two path sets
 *   (`path.xKey`, `path.yKey`) in ONE [ObservableState.update] batch.
 *
 * Reserved-mode pinboards keep their positions under
 * `state["__dnd"][group][key] = {x, y}`. That subtree is ordinary module
 * state (it persists and re-streams like any other key) and the typed DSL's
 * `syncBack` never replaces top-level `__`-prefixed keys, so a data class
 * that declares no `x`/`y` cannot wipe it.
 */
object HypenDnd {
    /** `__hypen_reorder` — move an item between/within bound arrays. */
    const val REORDER_ACTION = "__hypen_reorder"

    /** `__hypen_pin` — write a pinboard position. */
    const val PIN_ACTION = "__hypen_pin"

    /** Top-level state key holding reserved-mode pinboard positions. */
    const val RESERVED_STATE_KEY = "__dnd"

    /** Top-level keys with this prefix are runtime-owned and survive typed round-trips. */
    const val RESERVED_KEY_PREFIX = "__"

    /** Item base path for a reserved-mode pin: `__dnd.<group>.<key>`. */
    fun reservedPinPath(group: String, key: String): String = "$RESERVED_STATE_KEY.$group.$key"

    /** Item base path for a user-field-mode pin: `<bindPath>.<index>`. */
    fun userPinPath(bindPath: String, index: Int): String = "$bindPath.$index"

    /** Whether [key] is a runtime-owned top-level state key (`__dnd`, …). */
    fun isReservedKey(key: String): Boolean = key.startsWith(RESERVED_KEY_PREFIX)
}
