package device

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	wire "github.com/hypen-space/core/remote/device"
)

// Typed parameter and result shapes: the thin remote/device structs. Params
// are encoded with encoding/json and validated by the Rust broker when the
// request opens (invalid ⇒ CodeInvalidParams whose Detail names the JSON
// path and rule; nothing is sent); results are decoded with encoding/json
// from JSON the broker already validated.
type (
	Permission              = wire.Permission
	PermissionStatus        = wire.PermissionStatus
	PermissionParams        = wire.PermissionParams
	MediaType               = wire.MediaType
	GalleryPickParams       = wire.GalleryPickParams
	FilePickParams          = wire.FilePickParams
	CaptureMode             = wire.CaptureMode
	CameraFacing            = wire.CameraFacing
	CameraCaptureParams     = wire.CameraCaptureParams
	MicFormat               = wire.MicFormat
	MicRecordParams         = wire.MicRecordParams
	MicRecordResult         = wire.MicRecordResult
	BlobItem                = wire.BlobItem
	BluetoothSelectParams   = wire.BluetoothSelectParams
	SelectedBluetoothDevice = wire.SelectedBluetoothDevice
	BluetoothDevice         = wire.BluetoothDevice
)

// The closed permission enum (permission.query@1 / permission.request@1):
// the broker refuses any other name (a typo, an alias) as invalidParams.
const (
	PermissionCamera        = wire.PermissionCamera
	PermissionMicrophone    = wire.PermissionMicrophone
	PermissionPhotos        = wire.PermissionPhotos
	PermissionLocation      = wire.PermissionLocation
	PermissionNotifications = wire.PermissionNotifications
	PermissionBluetooth     = wire.PermissionBluetooth
	PermissionContacts      = wire.PermissionContacts

	PermissionGranted = wire.PermissionGranted
	PermissionDenied  = wire.PermissionDenied
	PermissionPrompt  = wire.PermissionPrompt

	MediaTypePhoto = wire.MediaTypePhoto
	MediaTypeVideo = wire.MediaTypeVideo

	CaptureModePhoto = wire.CaptureModePhoto
	CaptureModeVideo = wire.CaptureModeVideo

	CameraFacingFront = wire.CameraFacingFront
	CameraFacingBack  = wire.CameraFacingBack

	MicFormatPCM16 = wire.MicFormatPCM16
)

// Capability names.
const (
	CapabilityPermissionQuery   = "permission.query"
	CapabilityPermissionRequest = "permission.request"
	CapabilityGalleryPick       = "gallery.pick"
	CapabilityFilePick          = "file.pick"
	CapabilityFileSave          = "file.save"
	CapabilityCameraCapture     = "camera.capture"
	CapabilityMicRecord         = "mic.record"
	CapabilityBluetoothScan     = "bluetooth.scan"
	CapabilityBluetoothSelect   = "bluetooth.select"
)

// RequestAs runs a unary request and decodes its broker-validated result
// into R (e.g. RequestAs[wire.PermissionResult]).
func RequestAs[R any](ctx context.Context, d *Device, capability string, params any, opts ...Option) (R, *Result, error) {
	var zero R
	res, err := d.Request(ctx, capability, params, opts...)
	if err != nil {
		return zero, nil, err
	}
	var out R
	if err := res.Decode(&out); err != nil {
		return zero, res, err
	}
	return out, res, nil
}

// joinBlobs attaches each item's declared SHA-256 and name to the verified
// bytes of the same channel.
func joinBlobs(res *Result, items []BlobItem, names map[uint16]string) ([]Blob, error) {
	byChannel := make(map[uint16]Blob, len(res.Blobs))
	for _, b := range res.Blobs {
		byChannel[b.Channel] = b
	}
	out := make([]Blob, 0, len(items))
	for _, it := range items {
		b, ok := byChannel[it.Channel]
		if !ok {
			return nil, &Error{Code: CodeInternal, Detail: fmt.Sprintf("no verified bytes for channel %d", it.Channel)}
		}
		b.SHA256 = it.Sha256
		b.ContentType = it.ContentType
		if n, ok := names[it.Channel]; ok {
			b.Name = n
		}
		out = append(out, b)
	}
	return out, nil
}

// ---- permissions --------------------------------------------------------------

// Permissions is permission.query@1 / permission.request@1.
type Permissions struct{ d *Device }

// Permissions returns the typed permission helpers.
func (d *Device) Permissions() Permissions { return Permissions{d} }

// Query reads the live OS permission status without prompting.
func (p Permissions) Query(ctx context.Context, permission Permission, opts ...Option) (PermissionStatus, error) {
	return p.call(ctx, CapabilityPermissionQuery, permission, opts)
}

// Request asks the user for the permission (behind the host's consent UI).
// A denial is ErrDenied.
func (p Permissions) Request(ctx context.Context, permission Permission, opts ...Option) (PermissionStatus, error) {
	return p.call(ctx, CapabilityPermissionRequest, permission, opts)
}

func (p Permissions) call(ctx context.Context, capability string, permission Permission, opts []Option) (PermissionStatus, error) {
	out, _, err := RequestAs[wire.PermissionResult](ctx, p.d, capability, PermissionParams{Permission: permission}, opts...)
	if err != nil {
		return "", err
	}
	return out.Status, nil
}

// ---- gallery / files ------------------------------------------------------------

// Gallery is gallery.pick@1.
type Gallery struct{ d *Device }

// Gallery returns the typed gallery helpers.
func (d *Device) Gallery() Gallery { return Gallery{d} }

// Pick opens the host's photo/video picker and returns the chosen items,
// each hash-verified. An empty selection is a successful empty slice.
func (g Gallery) Pick(ctx context.Context, params GalleryPickParams, opts ...Option) ([]Blob, error) {
	out, res, err := RequestAs[wire.GalleryPickResult](ctx, g.d, CapabilityGalleryPick, params, opts...)
	if err != nil {
		return nil, err
	}
	return joinBlobs(res, out.Items, nil)
}

// Files is file.pick@1 and file.save@1.
type Files struct{ d *Device }

// Files returns the typed file helpers.
func (d *Device) Files() Files { return Files{d} }

// Pick opens the host's document picker; items carry their names. A nil
// Accept is sent as [] (no type filter).
func (f Files) Pick(ctx context.Context, params FilePickParams, opts ...Option) ([]Blob, error) {
	if params.Accept == nil {
		params.Accept = []string{}
	}
	out, res, err := RequestAs[wire.FilePickResult](ctx, f.d, CapabilityFilePick, params, opts...)
	if err != nil {
		return nil, err
	}
	items := make([]BlobItem, len(out.Items))
	names := make(map[uint16]string, len(out.Items))
	for i, it := range out.Items {
		items[i] = BlobItem{Channel: it.Channel, ContentType: it.ContentType, Bytes: it.Bytes, Sha256: it.Sha256}
		names[it.Channel] = it.Name
	}
	return joinBlobs(res, items, names)
}

// Save is Device.Save (file.save@1).
func (f Files) Save(ctx context.Context, name, contentType string, data []byte, opts ...Option) (*SaveResult, error) {
	return f.d.Save(ctx, name, contentType, data, opts...)
}

// ---- camera ---------------------------------------------------------------------

// Camera is camera.capture@1.
type Camera struct{ d *Device }

// Camera returns the typed camera helpers.
func (d *Device) Camera() Camera { return Camera{d} }

// Capture runs the host's capture UI (its own consent gate) and returns the
// one photo or video item, hash-verified and checked against the mode.
func (c Camera) Capture(ctx context.Context, params CameraCaptureParams, opts ...Option) (Blob, error) {
	out, res, err := RequestAs[wire.CameraCaptureResult](ctx, c.d, CapabilityCameraCapture, params, opts...)
	if err != nil {
		return Blob{}, err
	}
	blobs, err := joinBlobs(res, out.Items, nil)
	if err != nil {
		return Blob{}, err
	}
	if len(blobs) != 1 {
		return Blob{}, &Error{Code: CodeInvalidParams, Detail: "camera.capture returned no item"}
	}
	return blobs[0], nil
}

// Photo captures one photo (facing "" = host default).
func (c Camera) Photo(ctx context.Context, facing CameraFacing, opts ...Option) (Blob, error) {
	p := CameraCaptureParams{Mode: CaptureModePhoto}
	if facing != "" {
		p.Facing = &facing
	}
	return c.Capture(ctx, p, opts...)
}

// Video records one video of at most maxDurationMs (0 = no limit).
func (c Camera) Video(ctx context.Context, facing CameraFacing, maxDurationMs uint64, opts ...Option) (Blob, error) {
	p := CameraCaptureParams{Mode: CaptureModeVideo}
	if facing != "" {
		p.Facing = &facing
	}
	if maxDurationMs > 0 {
		p.MaxDurationMs = &maxDurationMs
	}
	return c.Capture(ctx, p, opts...)
}

// ---- microphone -----------------------------------------------------------------

// Mic is mic.record@1 (a binary-upload stream of little-endian PCM16).
type Mic struct{ d *Device }

// Mic returns the typed microphone helpers.
func (d *Device) Mic() Mic { return Mic{d} }

// Record streams a recording: onData receives the PCM16 bytes in order
// (credit flows back as it returns), and Record returns the verified
// result (durationMs, and the item's actual size and SHA-256 over every
// byte delivered) once the host ends it — its Stop control, maxDurationMs,
// or the deadline. Returning ErrStop (or any error) from onData cancels
// the recording; Record then returns that error.
func (m Mic) Record(ctx context.Context, params MicRecordParams, onData func(chunk []byte) error, opts ...Option) (*MicRecordResult, error) {
	if params.Format == "" {
		params.Format = MicFormatPCM16
	}
	s, err := m.d.Stream(ctx, CapabilityMicRecord, params, opts...)
	if err != nil {
		return nil, err
	}
	res, err := s.consume(ctx, func(it Item) error {
		if !it.IsData() || onData == nil {
			return nil
		}
		return onData(it.Data)
	})
	if err != nil {
		return nil, err
	}
	var out MicRecordResult
	if err := res.Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- bluetooth ------------------------------------------------------------------

// Bluetooth is bluetooth.select@1 and bluetooth.scan@1.
type Bluetooth struct{ d *Device }

// Bluetooth returns the typed Bluetooth helpers.
func (d *Device) Bluetooth() Bluetooth { return Bluetooth{d} }

// Select opens the host-owned chooser (the consent gate) and returns the
// identity of the device the user picked. Cancel in the chooser is
// ErrCancelled.
func (b Bluetooth) Select(ctx context.Context, params BluetoothSelectParams, opts ...Option) (SelectedBluetoothDevice, error) {
	out, _, err := RequestAs[wire.BluetoothSelectResult](ctx, b.d, CapabilityBluetoothSelect, params, opts...)
	if err != nil {
		return SelectedBluetoothDevice{}, err
	}
	return out.Device, nil
}

// Scan streams discovered devices to onDevice until the scan ends, ctx
// ends (cancelled), or onDevice returns ErrStop (the scan is cancelled and
// Scan returns nil) or another error (returned).
func (b Bluetooth) Scan(ctx context.Context, onDevice func(BluetoothDevice) error, opts ...Option) error {
	s, err := b.d.Stream(ctx, CapabilityBluetoothScan, json.RawMessage(`{}`), opts...)
	if err != nil {
		return err
	}
	_, err = s.consume(ctx, func(it Item) error {
		if it.IsData() {
			return nil
		}
		var ev wire.BluetoothScanEvent
		if err := json.Unmarshal(it.Event, &ev); err != nil {
			return &Error{Code: CodeInvalidParams, Detail: "bluetooth.scan event: " + err.Error()}
		}
		if onDevice == nil {
			return nil
		}
		return onDevice(ev.Device)
	})
	if errors.Is(err, ErrStop) {
		return nil
	}
	return err
}
