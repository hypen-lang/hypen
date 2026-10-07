package remote

// Cross-language end-to-end test of the Go device plane: the TypeScript web
// client (hypen-web RemoteEngine + FakeDeviceHost / DeviceClient, run with
// bun) connects over a real WebSocket to this Go server, whose device plane
// runs on the Rust broker (engine module, WASI via wazero).
//
//	cd hypen-golang && go test ./remote -run TestDeviceE2ETypeScriptClient -count=1 -v
//
// Needs `bun` on PATH and hypen-web's node_modules (`cd hypen-web && bun
// install`). Without them the test is skipped, unless HYPEN_E2E_REQUIRE=1
// (CI), which turns a missing toolchain into a failure.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/device"
)

type e2eState struct {
	Supports     string `json:"supports"`
	Query        string `json:"query"`
	QueryMic     string `json:"queryMic"`
	QueryResumed string `json:"queryResumed"`
	Pick         string `json:"pick"`
	Save         string `json:"save"`
	SaveSized    string `json:"saveSized"`
	Photo        string `json:"photo"`
	Video        string `json:"video"`
	Select       string `json:"select"`
	Scan         string `json:"scan"`
	Record       string `json:"record"`
	SlowPick     string `json:"slowPick"`
	SlowRequest  string `json:"slowRequest"`
}

const e2eUI = `module App {
	Column {
		Text("query @{state.query} pick @{state.pick} save @{state.save}")
		Text("scan @{state.scan} record @{state.record} slow @{state.slowPick} @{state.slowRequest}")
		Text("sized @{state.saveSized} photo @{state.photo} video @{state.video} select @{state.select}")
	}
}`

// e2ePhoto / e2eSave mirror the payloads in testdata/device_e2e_client.ts.
func e2ePhoto() []byte {
	b := make([]byte, 100_000)
	for i := range b {
		b[i] = byte((i*31 + 7) & 0xff)
	}
	return b
}

func e2eSaveBytes() []byte { return bytes.Repeat([]byte("hypen-e2e-save "), 10_000) }

// e2eSizedSave is the file.save payload of n bytes (mirrors sizedSave in
// the TypeScript client).
func e2eSizedSave(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte((i*7 + n) & 0xff)
	}
	return b
}

// e2eCameraPhoto / e2eCameraVideo mirror the camera scenario of the client.
func e2eCameraPhoto() []byte {
	b := make([]byte, 70_000)
	for i := range b {
		b[i] = byte((i*13 + 1) & 0xff)
	}
	return b
}

func e2eCameraVideo() []byte {
	var out []byte
	for c := 0; c < 3; c++ {
		for i := 0; i < 40_000; i++ {
			out = append(out, byte((i+c*29)&0xff))
		}
	}
	return out
}

func hexSum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func errText(err error) string {
	var de *device.Error
	if errors.As(err, &de) {
		return string(de.Code)
	}
	return "error:" + err.Error()
}

func e2eApp(rec *recorder) *core.ModuleDefinition {
	bg := context.Background()
	var mu sync.Mutex
	var cancelSlow context.CancelFunc
	return core.NewApp(e2eState{}).
		Name("App").
		OnAction("e2eSupports", func(ctx core.TypedActionContext[e2eState]) {
			d := ctx.Device()
			ctx.State.Supports = fmt.Sprintf("%v,%v,%v", d.Supports("gallery.pick"), d.Supports("mic.record"), d.Supports("camera.capture"))
		}).
		OnAction("e2eQuery", func(ctx core.TypedActionContext[e2eState]) {
			p, _ := ctx.Action.Payload.(map[string]any)
			perm, _ := p["permission"].(string)
			st, err := ctx.Device().Permissions().Query(bg, device.Permission(perm))
			out := string(st)
			if err != nil {
				out = errText(err)
			}
			if p["key"] == "queryResumed" {
				ctx.State.QueryResumed = out
			} else {
				ctx.State.Query = out
			}
			rec.put("e2eQuery", out, err)
		}).
		OnAction("e2eQueryMic", func(ctx core.TypedActionContext[e2eState]) {
			st, err := ctx.Device().Permissions().Query(bg, device.PermissionMicrophone)
			ctx.State.QueryMic = string(st)
			if err != nil {
				ctx.State.QueryMic = errText(err)
			}
		}).
		OnAction("e2ePick", func(ctx core.TypedActionContext[e2eState]) {
			items, err := ctx.Device().Gallery().Pick(bg, device.GalleryPickParams{
				MediaTypes: []device.MediaType{device.MediaTypePhoto}, MaxCount: 1,
			})
			if err != nil {
				ctx.State.Pick = errText(err)
				rec.put("e2ePick", nil, err)
				return
			}
			it := items[0]
			ctx.State.Pick = fmt.Sprintf("%d:%s:%s", len(it.Bytes), hexSum(it.Bytes), it.ContentType)
			rec.put("e2ePick", it, nil)
		}).
		OnAction("e2eSave", func(ctx core.TypedActionContext[e2eState]) {
			res, err := ctx.Device().Files().Save(bg, "e2e.txt", "text/plain", e2eSaveBytes())
			if err != nil {
				ctx.State.Save = errText(err)
				return
			}
			ctx.State.Save = fmt.Sprint(res.BytesWritten)
		}).
		OnAction("e2eSaveSized", func(ctx core.TypedActionContext[e2eState]) {
			// file.save at a caller-chosen size: the 2 KiB boundary where
			// wazero < v1.9 trapped, and 64 KiB+ (several frames).
			p, _ := ctx.Action.Payload.(map[string]any)
			n, _ := p["bytes"].(float64)
			res, err := ctx.Device().Files().Save(bg, "sized.bin", "application/octet-stream", e2eSizedSave(int(n)))
			if err != nil {
				ctx.State.SaveSized = errText(err)
				return
			}
			ctx.State.SaveSized = fmt.Sprintf("%d:%d", int(n), res.BytesWritten)
		}).
		OnAction("e2eSaveSizedReset", func(ctx core.TypedActionContext[e2eState]) {
			ctx.State.SaveSized = ""
		}).
		OnAction("e2ePhoto", func(ctx core.TypedActionContext[e2eState]) {
			blob, err := ctx.Device().Camera().Photo(bg, device.CameraFacingBack)
			if err != nil {
				ctx.State.Photo = errText(err)
				rec.put("e2ePhoto", nil, err)
				return
			}
			ctx.State.Photo = fmt.Sprintf("%d:%s:%s", len(blob.Bytes), hexSum(blob.Bytes), blob.ContentType)
			rec.put("e2ePhoto", blob, nil)
		}).
		OnAction("e2eVideo", func(ctx core.TypedActionContext[e2eState]) {
			blob, err := ctx.Device().Camera().Video(bg, device.CameraFacingFront, 5_000)
			if err != nil {
				ctx.State.Video = errText(err)
				rec.put("e2eVideo", nil, err)
				return
			}
			ctx.State.Video = fmt.Sprintf("%d:%s:%s", len(blob.Bytes), hexSum(blob.Bytes), blob.ContentType)
			rec.put("e2eVideo", blob, nil)
		}).
		OnAction("e2eSelect", func(ctx core.TypedActionContext[e2eState]) {
			prefix := "Heart"
			d, err := ctx.Device().Bluetooth().Select(bg, device.BluetoothSelectParams{
				Services: []string{"0000180d-0000-1000-8000-00805f9b34fb"}, NamePrefix: &prefix,
			})
			if err != nil {
				ctx.State.Select = errText(err)
				return
			}
			name := ""
			if d.Name != nil {
				name = *d.Name
			}
			ctx.State.Select = d.ID + "|" + name
		}).
		OnAction("e2eScan", func(ctx core.TypedActionContext[e2eState]) {
			var ids []string
			err := ctx.Device().Bluetooth().Scan(bg, func(d device.BluetoothDevice) error {
				ids = append(ids, d.ID)
				if len(ids) == 2 {
					return device.ErrStop
				}
				return nil
			})
			if err != nil {
				ctx.State.Scan = errText(err)
				return
			}
			ctx.State.Scan = strings.Join(ids, ",")
		}).
		OnAction("e2eRecord", func(ctx core.TypedActionContext[e2eState]) {
			var pcm []byte
			res, err := ctx.Device().Mic().Record(bg, device.MicRecordParams{SampleRate: 8000}, func(chunk []byte) error {
				pcm = append(pcm, chunk...)
				return nil
			})
			if err != nil {
				ctx.State.Record = errText(err)
				return
			}
			if res.Item.Sha256 != hexSum(pcm) || res.Item.Bytes != uint64(len(pcm)) {
				ctx.State.Record = "delivered bytes do not match the verified result"
				return
			}
			ctx.State.Record = fmt.Sprintf("%d:%s:%d", len(pcm), res.Item.Sha256, res.DurationMs)
		}).
		OnAction("e2eSlowPick", func(ctx core.TypedActionContext[e2eState]) {
			c, cancel := context.WithCancel(bg)
			mu.Lock()
			cancelSlow = cancel
			mu.Unlock()
			_, err := ctx.Device().Gallery().Pick(c, device.GalleryPickParams{
				MediaTypes: []device.MediaType{device.MediaTypePhoto}, MaxCount: 1,
			})
			switch {
			case errors.Is(err, device.ErrCancelled) && errors.Is(err, context.Canceled):
				ctx.State.SlowPick = "cancelled"
			case err != nil:
				ctx.State.SlowPick = errText(err)
			default:
				ctx.State.SlowPick = "unexpected success"
			}
			rec.put("e2eSlowPick", nil, err)
		}).
		OnAction("e2eCancelPick", func(ctx core.TypedActionContext[e2eState]) {
			mu.Lock()
			cancel := cancelSlow
			mu.Unlock()
			if cancel != nil {
				cancel()
			}
		}).
		OnAction("e2eSlowRequest", func(ctx core.TypedActionContext[e2eState]) {
			st, err := ctx.Device().Permissions().Request(bg, device.PermissionNotifications)
			ctx.State.SlowRequest = string(st)
			if err != nil {
				ctx.State.SlowRequest = errText(err)
			}
		}).
		Build()
}

func TestDeviceE2ETypeScriptClient(t *testing.T) {
	required := os.Getenv("HYPEN_E2E_REQUIRE") == "1"
	missing := func(why string) {
		if required {
			t.Fatalf("cross-language e2e prerequisites missing: %s", why)
		}
		t.Skipf("cross-language e2e skipped: %s (set HYPEN_E2E_REQUIRE=1 to fail instead)", why)
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		missing("bun is not on PATH")
	}
	web, _ := filepath.Abs(filepath.Join("..", "..", "hypen-web"))
	if _, err := os.Stat(filepath.Join(web, "node_modules", "@hypen-space", "core")); err != nil {
		missing("hypen-web/node_modules is not installed (cd hypen-web && bun install)")
	}

	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	s := newDevServer(t, &DeviceConfig{}, e2eApp(rec), e2eUI, nil, func(srv *RemoteServer) {
		srv.AllowedOrigins("http://app.e2e").
			Authenticate(func(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer e2e" })
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bun, "run", filepath.Join("testdata", "device_e2e_client.ts"), s.url)
	cmd.Env = append(os.Environ(), "NODE_ENV=test")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	checks := map[string]bool{}
	var done bool
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) != nil {
			continue
		}
		if name, ok := m["check"].(string); ok {
			pass, _ := m["ok"].(bool)
			checks[name] = pass
			if pass {
				t.Logf("ts ok   %s", name)
			} else {
				t.Errorf("ts FAIL %s: %s", name, line)
			}
		}
		if m["event"] == "done" {
			done = true
		}
	}
	waitErr := cmd.Wait()
	if !done || waitErr != nil {
		t.Fatalf("TypeScript client did not finish cleanly (%v)\nstderr:\n%s", waitErr, tail(stderr.String(), 4000))
	}

	for _, name := range []string{
		"origin-403", "no-credentials-403", "allowed-origin-admitted", "authenticator-admits",
		"handshake-device-ack", "core-capabilities-opened", "resume-token-issued", "supports",
		"permission-query", "permission-query-denied-status", "gallery-pick-hash-verified",
		"file-save-download", "file-save-2048", "file-save-64k-plus", "file-save-multi-window",
		"camera-capture-photo", "camera-capture-video", "bluetooth-select",
		"bluetooth-scan-events", "bluetooth-scan-cancelled-on-client",
		"mic-record-data", "cancel-handler-result", "cancel-reached-client", "slow-request-result",
		"lease-renewals", "resume-wrong-token-new-session", "resume-with-token", "resumed-plane-works",
	} {
		if !checks[name] {
			t.Errorf("check %s missing or failed", name)
		}
	}

	// What the Go handlers saw.
	pick := rec.wait(t, "e2ePick")
	if pick.err != nil {
		t.Fatalf("Go pick: %v", pick.err)
	}
	blob := pick.value.(device.Blob)
	if !bytes.Equal(blob.Bytes, e2ePhoto()) || blob.SHA256 != hexSum(e2ePhoto()) {
		t.Fatalf("Go received %d bytes (sha %s), want the client's photo", len(blob.Bytes), blob.SHA256)
	}
	photo := rec.wait(t, "e2ePhoto")
	if photo.err != nil {
		t.Fatalf("Go camera photo: %v", photo.err)
	}
	if pb := photo.value.(device.Blob); !bytes.Equal(pb.Bytes, e2eCameraPhoto()) || pb.ContentType != "image/jpeg" {
		t.Fatalf("Go received a %d-byte %s photo, want the client's capture", len(pb.Bytes), pb.ContentType)
	}
	video := rec.wait(t, "e2eVideo")
	if video.err != nil {
		t.Fatalf("Go camera video: %v", video.err)
	}
	if vb := video.value.(device.Blob); !bytes.Equal(vb.Bytes, e2eCameraVideo()) || vb.SHA256 != hexSum(e2eCameraVideo()) || vb.ContentType != "video/webm" {
		t.Fatalf("Go received a %d-byte %s video, want the client's recording", len(vb.Bytes), vb.ContentType)
	}
	slow := rec.wait(t, "e2eSlowPick")
	if !errors.Is(slow.err, context.Canceled) {
		t.Fatalf("slow pick: %v", slow.err)
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
