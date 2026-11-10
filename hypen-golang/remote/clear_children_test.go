package remote

import (
	"encoding/json"
	"testing"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

// The server relays clearChildren (hypen-web/docs/clear-children.md) to
// clients untouched: engine patch → wire patch → JSON is exactly
// {"type":"clearChildren","id":…}, and the Go client decodes it back.
func TestClearChildren_RelayedUnchanged(t *testing.T) {
	out := corePatchesToRemote([]core.Patch{
		{Type: core.PatchClearChildren, ID: "4294967301"},
		{Type: core.PatchCreate, ID: "9", ElementType: "Text", Props: map[string]any{"0": "x"}},
	})
	b, err := json.Marshal(out[0])
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(b), `{"type":"clearChildren","id":"4294967301"}`; got != want {
		t.Errorf("wire = %s, want %s", got, want)
	}

	msg, _ := json.Marshal(&PatchMessage{Type: MessageTypePatch, Module: "App", Patches: out, Revision: 2})
	var raw RawMessage
	if err := json.Unmarshal(msg, &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Patches) != 2 || raw.Patches[0].Type != "clearChildren" || raw.Patches[0].ID != "4294967301" {
		t.Errorf("decoded patches = %+v", raw.Patches)
	}
}
