package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/device"
	"github.com/hypen-space/core/remote"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type State struct {
	Server  string `json:"server"`
	Runs    int    `json:"runs"`
	Result  string `json:"result"`
	Detail  string `json:"detail"`
	History string `json:"history"`
}

func main() {
	ui, err := os.ReadFile("../examples/device-lab/app.hypen")
	if err != nil {
		panic(err)
	}
	builder := core.NewApp(State{Server: "Go", Result: "Connected. Choose a check."}).Name("App")
	var pending sync.Map
	for _, name := range []string{"status", "query", "permission", "gallery", "file", "save", "camera", "record", "scan", "bluetooth", "cancel", "ping"} {
		action := name
		builder.OnAction(action, func(c core.TypedActionContext[State]) {
			d := c.Device()
			owner := d.Owner()
			if action == "cancel" {
				if stop, ok := pending.Load(owner); ok {
					(*stop.(*context.CancelFunc))()
				}
				return
			}
			c.State.Runs++
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			if action != "status" && action != "ping" {
				pending.Store(owner, &cancel)
				defer pending.CompareAndDelete(owner, &cancel)
			}
			var result any
			var err error
			switch action {
			case "status":
				v := map[string]bool{}
				for _, n := range []string{"gallery.pick", "file.pick", "file.save", "camera.capture", "mic.record", "bluetooth.scan", "bluetooth.select", "permission.query", "permission.request"} {
					v[n] = d.Supports(n)
				}
				result = v
			case "query":
				result, err = d.Permissions().Query(ctx, device.PermissionCamera)
			case "permission":
				result, err = d.Permissions().Request(ctx, device.PermissionMicrophone)
			case "save":
				result, err = d.Files().Save(ctx, "device-lab.txt", "text/plain", []byte(strings.Repeat("Device Lab payload 0123456789\n", 3400)))
			case "gallery", "file", "camera", "bluetooth":
				cap := "gallery.pick"
				params := map[string]any{"mediaTypes": []string{"photo"}, "maxCount": 1}
				if action == "file" {
					cap = "file.pick"
					params = map[string]any{"accept": []string{"text/plain", ".txt"}, "maxCount": 2}
				}
				if action == "camera" {
					cap = "camera.capture"
					params = map[string]any{"mode": "photo", "facing": "back"}
				}
				if action == "bluetooth" {
					cap = "bluetooth.select"
					params = map[string]any{}
				}
				var r *device.Result
				r, err = d.Request(ctx, cap, params)
				if r != nil {
					var value any
					_ = json.Unmarshal(r.JSON, &value)
					blobs := []any{}
					for _, b := range r.Blobs {
						h := sha256.Sum256(b.Bytes)
						digest := hex.EncodeToString(h[:])
						_ = os.MkdirAll("../examples/device-lab/results-2026-09-26/uploads", 0755)
						_ = os.WriteFile("../examples/device-lab/results-2026-09-26/uploads/"+digest+".bin", b.Bytes, 0644)
						blobs = append(blobs, map[string]any{"bytes": len(b.Bytes), "sha256": digest})
					}
					result = map[string]any{"value": value, "verifiedBlobs": blobs}
				}
			case "record":
				duration := uint64(3000)
				channels := uint8(1)
				count := 0
				digest := sha256.New()
				r, e := d.Mic().Record(ctx, device.MicRecordParams{SampleRate: 16000, MaxDurationMs: &duration, Channels: &channels}, func(chunk []byte) error {
					count += len(chunk)
					_, err := digest.Write(chunk)
					return err
				})
				err = e
				result = map[string]any{"value": r, "bytes": count, "sha256": hex.EncodeToString(digest.Sum(nil))}
			case "scan":
				scanCtx, stop := context.WithTimeout(ctx, 3*time.Second)
				defer stop()
				count := 0
				err = d.Bluetooth().Scan(scanCtx, func(v device.BluetoothDevice) error { count++; return nil })
				result = map[string]any{"events": count}
			case "ping":
				result = "UI remains responsive"
			}
			status := "OK"
			if err != nil {
				status = err.Error()
			}
			data, _ := json.Marshal(result)
			c.State.Result = action + ": " + status
			c.State.Detail = string(data)
			c.State.History = c.State.Result + "\n" + c.State.History
			fmt.Println("DEVICE_LAB", action, status, string(data))
		})
	}
	remote.NewRemoteServer().WithDefinition(builder.Build()).UI("module App {" + string(ui) + "}").Source("../examples/device-lab").Config(remote.ServerConfig{Hostname: "127.0.0.1", DisableCompression: os.Getenv("DEVICE_LAB_NO_COMPRESSION") == "1"}).AllowedOrigins("http://127.0.0.1:45100").Authenticate(func(r *http.Request) bool { return r.URL.Query().Get("token") == "device-lab" }).Listen(45102)
	select {}
}
