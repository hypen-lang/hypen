package device

import "fmt"

// Thin typed surface of the Device Capability Protocol (RFC 001) for the Go
// handler API. Nothing here validates: the Rust broker is the ONLY device
// protocol decoder, validator and negotiator.
//
//   - Params structs are encoded with plain encoding/json and handed to the
//     broker's open, which validates them against the selected revision
//     (invalid ⇒ a local invalidParams refusal whose detail names the JSON
//     path and rule; nothing is sent).
//   - Result and event structs are decoded with plain encoding/json from
//     JSON the broker already validated (strict decoding, JSON limits,
//     per-revision schema, blob verification).
//   - The string enums list the closed wire values for convenience; a value
//     outside them is refused by the broker, not here.

// Transport constants (RFC 001 §2.1/§2.3). The broker is authoritative
// (BrokerRuntime.Constants reports the values it was built with; the
// binding tests pin these two to it); the transport only needs them to route
// bytes before the broker sees them.
const (
	// DeviceProtocolVersion is the device protocol version this SDK speaks.
	DeviceProtocolVersion uint32 = 1
	// MaxMessageBytes is the device text limit: longer device text is a
	// connection-level violation decided without parsing (IsOversizeText).
	MaxMessageBytes = 1 << 20
	// FrameHeaderLen is the fixed binary frame header length:
	// [u8 version=1][u8 flags=0][u16 channel][u32 requestId][u32 seq], LE.
	FrameHeaderLen = 12
	// CoreCapabilitiesName is the connection-owned control stream the
	// broker opens after the handshake; application code never opens it.
	CoreCapabilitiesName = "core.capabilities"
)

// DeviceErrorCode is the closed error taxonomy for protocol v1 (RFC 001 §3).
type DeviceErrorCode string

const (
	ErrorUnsupported    DeviceErrorCode = "unsupported"
	ErrorUnavailable    DeviceErrorCode = "unavailable"
	ErrorDenied         DeviceErrorCode = "denied"
	ErrorRevoked        DeviceErrorCode = "revoked"
	ErrorCancelled      DeviceErrorCode = "cancelled"
	ErrorTimeout        DeviceErrorCode = "timeout"
	ErrorThrottled      DeviceErrorCode = "throttled"
	ErrorConnectionLost DeviceErrorCode = "connectionLost"
	ErrorInvalidParams  DeviceErrorCode = "invalidParams"
	ErrorInternal       DeviceErrorCode = "internal"
)

// Lifetime is the requested lifetime of a device operation (RFC 001 §2.7).
type Lifetime string

const (
	// LifetimeActivation: owned by an exact {moduleInstanceId, activationId};
	// swept on deactivation.
	LifetimeActivation Lifetime = "activation"
	// LifetimeBackground: owned by {moduleInstanceId}; swept on destruction,
	// not on deactivation.
	LifetimeBackground Lifetime = "background"
	// LifetimeConnection: reserved for protocol control (core.*).
	LifetimeConnection Lifetime = "connection"
)

// BlobItem is a completed blob item as reported in a terminal result: the
// item's actual byte count and lowercase hex SHA-256, which the broker has
// verified against the bytes it received.
type BlobItem struct {
	Channel     uint16 `json:"channel"`
	ContentType string `json:"contentType"`
	Bytes       uint64 `json:"bytes"`
	Sha256      string `json:"sha256"`
}

// ---- gallery.pick@1 ----

// MediaType selects what a gallery picker may return.
type MediaType string

const (
	MediaTypePhoto MediaType = "photo"
	MediaTypeVideo MediaType = "video"
)

// GalleryPickParams is gallery.pick@1 params (mediaTypes: 1..2 unique
// values; maxCount: 1..16).
type GalleryPickParams struct {
	MediaTypes []MediaType `json:"mediaTypes"`
	MaxCount   uint16      `json:"maxCount"`
}

// GalleryPickResult is gallery.pick@1 result.
type GalleryPickResult struct {
	Items []BlobItem `json:"items"`
}

// ---- file.pick@1 / file.save@1 ----

// FilePickParams is file.pick@1 params (accept: 1..32 MIME patterns;
// maxCount: 1..16).
type FilePickParams struct {
	Accept   []string `json:"accept"`
	MaxCount uint16   `json:"maxCount"`
}

// FileItem is one picked file: a BlobItem with its name.
type FileItem struct {
	Channel     uint16 `json:"channel"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Bytes       uint64 `json:"bytes"`
	Sha256      string `json:"sha256"`
}

// FilePickResult is file.pick@1 result.
type FilePickResult struct {
	Items []FileItem `json:"items"`
}

// FileSaveParams is file.save@1 params: the announcement of the single
// download channel (always 0). The broker checks it against the download
// bytes it is given.
type FileSaveParams struct {
	Channel     uint16 `json:"channel"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Bytes       uint64 `json:"bytes"`
	Sha256      string `json:"sha256"`
}

// FileSaveResult is file.save@1 result: the client's write receipt.
type FileSaveResult struct {
	BytesWritten uint64 `json:"bytesWritten"`
}

// ---- permission.query@1 / permission.request@1 ----

// PermissionStatus is a live OS permission snapshot.
type PermissionStatus string

const (
	PermissionGranted PermissionStatus = "granted"
	PermissionDenied  PermissionStatus = "denied"
	PermissionPrompt  PermissionStatus = "prompt"
)

// Permission is the closed permission set of permission.query@1 and
// permission.request@1 (RFC 001 §3). Every host maps the SAME names;
// anything else (a typo, an alias such as "geolocation", another case) is
// refused by the broker as invalidParams.
type Permission string

const (
	PermissionCamera        Permission = "camera"
	PermissionMicrophone    Permission = "microphone"
	PermissionPhotos        Permission = "photos"
	PermissionLocation      Permission = "location"
	PermissionNotifications Permission = "notifications"
	PermissionBluetooth     Permission = "bluetooth"
	PermissionContacts      Permission = "contacts"
)

// AllPermissions returns every permission name, in schema enum order.
func AllPermissions() []Permission {
	return []Permission{
		PermissionCamera, PermissionMicrophone, PermissionPhotos, PermissionLocation,
		PermissionNotifications, PermissionBluetooth, PermissionContacts,
	}
}

// PermissionParams is the params shape of permission.query@1 and
// permission.request@1.
type PermissionParams struct {
	Permission Permission `json:"permission"`
}

// PermissionResult is the result shape of permission.query@1 and
// permission.request@1.
type PermissionResult struct {
	Status PermissionStatus `json:"status"`
}

// ---- bluetooth.scan@1 ----

// BluetoothDevice is one discovered device.
type BluetoothDevice struct {
	ID string `json:"id"`
	// Name is the advertised name; nil = absent on the wire.
	Name *string `json:"name,omitempty"`
	Rssi int16   `json:"rssi"`
}

// BluetoothScanEvent is bluetooth.scan@1 event.
type BluetoothScanEvent struct {
	Device BluetoothDevice `json:"device"`
}

// ---- bluetooth.select@1 ----

// ExpandBluetoothUUID16 returns the canonical lowercase 128-bit spelling
// the wire uses for a 16-bit SIG-assigned id (0x180d →
// 0000180d-0000-1000-8000-00805f9b34fb).
func ExpandBluetoothUUID16(id uint16) string {
	return fmt.Sprintf("%08x-0000-1000-8000-00805f9b34fb", uint32(id))
}

// BluetoothSelectParams is bluetooth.select@1 params: optional filters for
// the host-owned chooser.
type BluetoothSelectParams struct {
	// Services holds 1..16 unique canonical lowercase 128-bit service UUIDs
	// (ExpandBluetoothUUID16); nil = absent on the wire.
	Services []string `json:"services,omitempty"`
	// NamePrefix is 1..64 code points; nil = absent on the wire.
	NamePrefix *string `json:"namePrefix,omitempty"`
}

// SelectedBluetoothDevice is the device the user chose (identity only).
type SelectedBluetoothDevice struct {
	ID string `json:"id"`
	// Name is the advertised name; nil = absent on the wire.
	Name *string `json:"name,omitempty"`
}

// BluetoothSelectResult is bluetooth.select@1 result.
type BluetoothSelectResult struct {
	Device SelectedBluetoothDevice `json:"device"`
}

// ---- mic.record@1 ----

// MicFormat is the capture encoding (pcm16 only in v1).
type MicFormat string

// MicFormatPCM16 is little-endian 16-bit PCM.
const MicFormatPCM16 MicFormat = "pcm16"

// MicRecordParams is mic.record@1 params.
type MicRecordParams struct {
	SampleRate uint32    `json:"sampleRate"`
	Format     MicFormat `json:"format"`
	// MaxDurationMs is an optional recording limit in ms; nil = absent.
	MaxDurationMs *uint64 `json:"maxDurationMs,omitempty"`
	// Channels is 1 or 2 (interleaved PCM16 when 2); nil = absent = 1.
	Channels *uint8 `json:"channels,omitempty"`
}

// MicRecordResult is mic.record@1 result.
type MicRecordResult struct {
	DurationMs uint64   `json:"durationMs"`
	Item       BlobItem `json:"item"`
}

// ---- camera.capture@1 ----

// CaptureMode is what camera.capture@1 records.
type CaptureMode string

const (
	CaptureModePhoto CaptureMode = "photo"
	CaptureModeVideo CaptureMode = "video"
)

// CameraFacing is the preferred camera.
type CameraFacing string

const (
	CameraFacingFront CameraFacing = "front"
	CameraFacingBack  CameraFacing = "back"
)

// CameraCaptureParams is camera.capture@1 params.
type CameraCaptureParams struct {
	Mode CaptureMode `json:"mode"`
	// Facing is the preferred camera; nil = absent (host default).
	Facing *CameraFacing `json:"facing,omitempty"`
	// MaxDurationMs is video only (a recording limit in ms); nil = absent.
	MaxDurationMs *uint64 `json:"maxDurationMs,omitempty"`
}

// CameraCaptureResult is camera.capture@1 result: exactly one item whose
// media type the broker checked against the mode.
type CameraCaptureResult struct {
	Items []BlobItem `json:"items"`
}
