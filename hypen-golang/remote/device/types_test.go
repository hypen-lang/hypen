package device

// Drift guards for the thin typed surface (types.go). The structs carry no
// validation, so what can drift is their shape: a JSON tag that no longer
// names a schema property, a required member marked omitempty, an enum
// constant the schema no longer lists, or a transport constant the broker
// no longer uses. The exported schemas (engine-compatibility-tests/schema/
// device/, generated from the Rust declarations) and the broker's own
// constants are the source of truth. The behavioural half — every
// broker-validated corpus value decodes into these structs and re-encodes
// exactly — is typedDecode in conformance_shared_test.go.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func loadSchema(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(compatPath(t, "schema", "device"), name+".schema.json"))
	if err != nil {
		t.Fatalf("read schema %s: %v", name, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse schema %s: %v", name, err)
	}
	return doc
}

// walk follows a dotted path through maps and arrays ("$defs.params.oneOf.0"),
// resolving local "$ref"s along the way.
func walk(t *testing.T, doc any, path string) any {
	t.Helper()
	root := doc
	resolve := func(n any) any {
		for i := 0; i < 8; i++ {
			m, ok := n.(map[string]any)
			if !ok {
				return n
			}
			ref, ok := m["$ref"].(string)
			if !ok || !strings.HasPrefix(ref, "#/") {
				return n
			}
			n = walk(t, root, strings.ReplaceAll(strings.TrimPrefix(ref, "#/"), "/", "."))
		}
		return n
	}
	node := doc
	for _, seg := range strings.Split(path, ".") {
		node = resolve(node)
		switch n := node.(type) {
		case map[string]any:
			next, ok := n[seg]
			if !ok {
				t.Fatalf("schema path %s: missing key %q", path, seg)
			}
			node = next
		case []any:
			i, err := strconv.Atoi(seg)
			if err != nil || i < 0 || i >= len(n) {
				t.Fatalf("schema path %s: bad index %q", path, seg)
			}
			node = n[i]
		default:
			t.Fatalf("schema path %s: cannot descend into %T at %q", path, node, seg)
		}
	}
	return resolve(node)
}

func sortedStrings(v any) []string {
	out := []string{}
	for _, item := range v.([]any) {
		out = append(out, item.(string))
	}
	sort.Strings(out)
	return out
}

// jsonTags returns a struct's JSON property names and the subset that is
// always emitted (no omitempty) — Go's "required".
func jsonTags(t *testing.T, typ reflect.Type) (all, required []string) {
	t.Helper()
	all, required = []string{}, []string{}
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		parts := strings.Split(f.Tag.Get("json"), ",")
		if parts[0] == "" || parts[0] == "-" {
			t.Fatalf("%s.%s has no usable json tag", typ, f.Name)
		}
		all = append(all, parts[0])
		omit := false
		for _, o := range parts[1:] {
			omit = omit || o == "omitempty"
		}
		if !omit {
			required = append(required, parts[0])
		}
	}
	sort.Strings(all)
	sort.Strings(required)
	return all, required
}

// objectProps is a closed object's properties and required set; a oneOf of
// closed objects (camera.capture params) is their union / intersection.
func objectProps(t *testing.T, node map[string]any) (props map[string]any, required []string) {
	t.Helper()
	if branches, ok := node["oneOf"].([]any); ok {
		props = map[string]any{}
		counts := map[string]int{}
		for _, b := range branches {
			p, r := objectProps(t, b.(map[string]any))
			for k, v := range p {
				props[k] = v
			}
			for _, k := range r {
				counts[k]++
			}
		}
		required = []string{}
		for k, n := range counts {
			if n == len(branches) {
				required = append(required, k)
			}
		}
		sort.Strings(required)
		return props, required
	}
	if node["type"] != "object" || node["additionalProperties"] != false {
		t.Fatalf("schema node is not a closed object: %v", node)
	}
	props, _ = node["properties"].(map[string]any)
	if props == nil {
		props = map[string]any{}
	}
	required = []string{}
	if r, ok := node["required"]; ok {
		required = sortedStrings(r)
	}
	return props, required
}

func TestTypedStructsMatchTheSchemas(t *testing.T) {
	shapes := []struct {
		schema, path string
		typ          reflect.Type
	}{
		{"gallery.pick-v1", "$defs.params", reflect.TypeOf(GalleryPickParams{})},
		{"gallery.pick-v1", "$defs.result", reflect.TypeOf(GalleryPickResult{})},
		{"gallery.pick-v1", "$defs.result.properties.items.items", reflect.TypeOf(BlobItem{})},
		{"file.pick-v1", "$defs.params", reflect.TypeOf(FilePickParams{})},
		{"file.pick-v1", "$defs.result", reflect.TypeOf(FilePickResult{})},
		{"file.pick-v1", "$defs.result.properties.items.items", reflect.TypeOf(FileItem{})},
		{"file.save-v1", "$defs.params", reflect.TypeOf(FileSaveParams{})},
		{"file.save-v1", "$defs.result", reflect.TypeOf(FileSaveResult{})},
		{"permission.query-v1", "$defs.params", reflect.TypeOf(PermissionParams{})},
		{"permission.query-v1", "$defs.result", reflect.TypeOf(PermissionResult{})},
		{"permission.request-v1", "$defs.params", reflect.TypeOf(PermissionParams{})},
		{"permission.request-v1", "$defs.result", reflect.TypeOf(PermissionResult{})},
		{"bluetooth.scan-v1", "$defs.params", reflect.TypeOf(struct{}{})},
		{"bluetooth.scan-v1", "$defs.device", reflect.TypeOf(BluetoothScanEvent{})},
		{"bluetooth.scan-v1", "$defs.device.properties.device", reflect.TypeOf(BluetoothDevice{})},
		{"bluetooth.select-v1", "$defs.params", reflect.TypeOf(BluetoothSelectParams{})},
		{"bluetooth.select-v1", "$defs.result", reflect.TypeOf(BluetoothSelectResult{})},
		{"bluetooth.select-v1", "$defs.result.properties.device", reflect.TypeOf(SelectedBluetoothDevice{})},
		{"mic.record-v1", "$defs.params", reflect.TypeOf(MicRecordParams{})},
		{"mic.record-v1", "$defs.result", reflect.TypeOf(MicRecordResult{})},
		{"mic.record-v1", "$defs.result.properties.item", reflect.TypeOf(BlobItem{})},
		{"camera.capture-v1", "$defs.params", reflect.TypeOf(CameraCaptureParams{})},
		{"camera.capture-v1", "$defs.result", reflect.TypeOf(CameraCaptureResult{})},
		{"camera.capture-v1", "$defs.result.properties.items.items", reflect.TypeOf(BlobItem{})},
	}
	for _, s := range shapes {
		s := s
		t.Run(s.schema+"/"+s.path, func(t *testing.T) {
			node, ok := walk(t, loadSchema(t, s.schema), s.path).(map[string]any)
			if !ok {
				t.Fatalf("not an object schema")
			}
			props, required := objectProps(t, node)
			names := []string{}
			for k := range props {
				names = append(names, k)
			}
			sort.Strings(names)
			all, req := jsonTags(t, s.typ)
			if !reflect.DeepEqual(names, all) {
				t.Errorf("properties drift\n schema %v\n struct %v", names, all)
			}
			if !reflect.DeepEqual(required, req) {
				t.Errorf("required drift (Go: fields without omitempty)\n schema %v\n struct %v", required, req)
			}
		})
	}
}

func TestEnumConstantsMatchTheSchemas(t *testing.T) {
	strs := func(vs ...any) []string {
		out := make([]string, len(vs))
		for i, v := range vs {
			out[i] = reflect.ValueOf(v).String()
		}
		sort.Strings(out)
		return out
	}
	cases := []struct {
		schema, path string
		want         []string
	}{
		{"envelope-v1", "$defs.error.properties.code.enum", strs(ErrorUnsupported, ErrorUnavailable, ErrorDenied, ErrorRevoked,
			ErrorCancelled, ErrorTimeout, ErrorThrottled, ErrorConnectionLost, ErrorInvalidParams, ErrorInternal)},
		{"envelope-v1", "$defs.deviceRequest.properties.lifetime.enum", strs(LifetimeActivation, LifetimeBackground, LifetimeConnection)},
		{"gallery.pick-v1", "$defs.params.properties.mediaTypes.items.enum", strs(MediaTypePhoto, MediaTypeVideo)},
		{"permission.query-v1", "$defs.result.properties.status.enum", strs(PermissionGranted, PermissionDenied, PermissionPrompt)},
		{"permission.request-v1", "$defs.result.properties.status.enum", strs(PermissionGranted, PermissionDenied, PermissionPrompt)},
		{"mic.record-v1", "$defs.params.properties.format.enum", strs(MicFormatPCM16)},
		{"camera.capture-v1", "$defs.params.oneOf.0.properties.facing.enum", strs(CameraFacingFront, CameraFacingBack)},
		{"camera.capture-v1", "$defs.params.oneOf.1.properties.facing.enum", strs(CameraFacingFront, CameraFacingBack)},
	}
	perms := make([]any, 0, 7)
	for _, p := range AllPermissions() {
		perms = append(perms, p)
	}
	cases = append(cases,
		struct {
			schema, path string
			want         []string
		}{"permission.query-v1", "$defs.params.properties.permission.enum", strs(perms...)},
		struct {
			schema, path string
			want         []string
		}{"permission.request-v1", "$defs.params.properties.permission.enum", strs(perms...)},
	)
	for _, c := range cases {
		if got := sortedStrings(walk(t, loadSchema(t, c.schema), c.path)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s: schema %v, Go %v", c.schema, c.path, got, c.want)
		}
	}
	for _, c := range []struct {
		schema, path string
		want         any
	}{
		{"camera.capture-v1", "$defs.params.oneOf.0.properties.mode.const", string(CaptureModePhoto)},
		{"camera.capture-v1", "$defs.params.oneOf.1.properties.mode.const", string(CaptureModeVideo)},
		{"file.save-v1", "$defs.params.properties.channel.const", float64(0)},
	} {
		if got := walk(t, loadSchema(t, c.schema), c.path); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s: schema %v, Go %v", c.schema, c.path, got, c.want)
		}
	}
	if got := ExpandBluetoothUUID16(0x180d); got != "0000180d-0000-1000-8000-00805f9b34fb" {
		t.Errorf("ExpandBluetoothUUID16 = %s", got)
	}
}

// The transport constants are the broker's.
func TestTransportConstantsMatchTheBroker(t *testing.T) {
	c, err := sharedTestRuntime(t).Constants()
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]float64{
		"protocolVersion": float64(DeviceProtocolVersion),
		"maxMessageBytes": MaxMessageBytes,
		"frameHeaderLen":  FrameHeaderLen,
	} {
		if c[name] != want {
			t.Errorf("%s: broker %v, Go %v", name, c[name], want)
		}
	}
}
