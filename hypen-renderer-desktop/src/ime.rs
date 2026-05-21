//! IME (input method) state machine.
//!
//! `winit::event::Ime` events arrive in four flavours: `Enabled`,
//! `Preedit(text, cursor)`, `Commit(text)`, and `Disabled`. The window
//! event handler delegates the pure state mutation to
//! [`apply_ime_transition`] and only handles the side effect (text
//! insertion on commit) itself, so the entire transition table stays
//! testable without spinning up an `App`.

use winit::event::Ime;

/// What [`apply_ime_transition`] needs the caller to do as a side
/// effect after the pure state update lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ImeEffect {
    /// Pure state update (preedit / active toggle); nothing else to do.
    None,
    /// Insert this text at the current selection. The caller is
    /// responsible for the actual `replace_selection_with` (it needs
    /// the focused Input's value + bind path, which the pure
    /// transition function doesn't see).
    Commit(String),
}

/// Pure state-machine for IME events. Mutates `preedit` + `ime_active`
/// in place; returns the side-effect the caller still owes.
///
/// Contract:
/// - `Enabled`: flips `ime_active` to true, clears any stale preedit.
/// - `Preedit(text, _)`: stores `(focused_id, text)` if focused on an
///   Input AND the text is non-empty; clears preedit otherwise.
///   Without a focused Input it's a no-op (the OS shouldn't deliver
///   preedits when there's nowhere to put them, but be forgiving).
/// - `Commit(text)`: clears preedit; returns `Commit(text)` to ask the
///   caller to insert `text` (empty commits → `None`).
/// - `Disabled`: flips `ime_active` to false, clears preedit.
pub(crate) fn apply_ime_transition(
    preedit: &mut Option<(String, String)>,
    ime_active: &mut bool,
    focused_input_id: Option<&str>,
    event: Ime,
) -> ImeEffect {
    match event {
        Ime::Enabled => {
            *ime_active = true;
            *preedit = None;
            ImeEffect::None
        }
        Ime::Preedit(text, _cursor_range) => {
            let id = match focused_input_id {
                Some(id) => id,
                None => return ImeEffect::None,
            };
            *preedit = if text.is_empty() {
                None
            } else {
                Some((id.to_string(), text))
            };
            ImeEffect::None
        }
        Ime::Commit(text) => {
            *preedit = None;
            if text.is_empty() {
                ImeEffect::None
            } else {
                ImeEffect::Commit(text)
            }
        }
        Ime::Disabled => {
            *ime_active = false;
            *preedit = None;
            ImeEffect::None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ime_enabled_sets_active_clears_stale_preedit() {
        let mut pre = Some(("stale".into(), "garbage".into()));
        let mut active = false;
        let effect = apply_ime_transition(&mut pre, &mut active, Some("input"), Ime::Enabled);
        assert!(active);
        assert_eq!(pre, None);
        assert_eq!(effect, ImeEffect::None);
    }

    #[test]
    fn ime_preedit_with_text_stores_pair() {
        let mut pre = None;
        let mut active = true;
        let effect = apply_ime_transition(
            &mut pre,
            &mut active,
            Some("name"),
            Ime::Preedit("こん".into(), None),
        );
        assert_eq!(pre, Some(("name".to_string(), "こん".to_string())));
        assert!(active);
        assert_eq!(effect, ImeEffect::None);
    }

    #[test]
    fn ime_preedit_empty_clears_preedit() {
        let mut pre = Some(("name".to_string(), "こん".to_string()));
        let mut active = true;
        let effect = apply_ime_transition(
            &mut pre,
            &mut active,
            Some("name"),
            Ime::Preedit(String::new(), None),
        );
        assert_eq!(pre, None);
        assert_eq!(effect, ImeEffect::None);
    }

    #[test]
    fn ime_preedit_without_focused_input_is_noop() {
        let mut pre = None;
        let mut active = true;
        let effect = apply_ime_transition(
            &mut pre,
            &mut active,
            None,
            Ime::Preedit("hello".into(), None),
        );
        assert_eq!(pre, None);
        assert!(active);
        assert_eq!(effect, ImeEffect::None);
    }

    #[test]
    fn ime_commit_returns_text_and_clears_preedit() {
        let mut pre = Some(("name".to_string(), "こん".to_string()));
        let mut active = true;
        let effect = apply_ime_transition(
            &mut pre,
            &mut active,
            Some("name"),
            Ime::Commit("今日は".into()),
        );
        assert_eq!(pre, None);
        assert!(active, "Commit must not toggle ime_active off");
        assert_eq!(effect, ImeEffect::Commit("今日は".into()));
    }

    #[test]
    fn ime_commit_empty_clears_preedit_without_inserting() {
        let mut pre = Some(("name".to_string(), "こん".to_string()));
        let mut active = true;
        let effect = apply_ime_transition(
            &mut pre,
            &mut active,
            Some("name"),
            Ime::Commit(String::new()),
        );
        assert_eq!(pre, None);
        assert_eq!(effect, ImeEffect::None);
    }

    #[test]
    fn ime_disabled_clears_everything() {
        let mut pre = Some(("name".to_string(), "こん".to_string()));
        let mut active = true;
        let effect = apply_ime_transition(
            &mut pre,
            &mut active,
            Some("name"),
            Ime::Disabled,
        );
        assert!(!active);
        assert_eq!(pre, None);
        assert_eq!(effect, ImeEffect::None);
    }
}
