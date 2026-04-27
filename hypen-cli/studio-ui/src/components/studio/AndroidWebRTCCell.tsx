/**
 * Android WebRTC mirror cell.
 *
 * Wraps Google's `android-emulator-webrtc` <Emulator> component, which
 * connects to the emulator's gRPC endpoint (exposed when the emulator is
 * launched with `-grpc <port>`) and renders a live WebRTC video stream
 * with input forwarding.
 *
 * Studio cold-boots emulators with `-grpc <port>` so this works
 * automatically. Emulators launched outside studio won't have the gRPC
 * endpoint available — the cell falls back to MJPEG via the parent
 * <DeviceMirror> when `webrtcUrl` is null.
 */
import { useState } from "react";
// @ts-expect-error — package ships JS without types
import { Emulator } from "android-emulator-webrtc/emulator";

export interface AndroidWebRTCCellProps {
  uri: string;
  name: string;
  onError?: () => void;
}

export function AndroidWebRTCCell({ uri, name, onError }: AndroidWebRTCCellProps) {
  const [errored, setErrored] = useState(false);
  if (errored) return null;
  return (
    <div className="absolute inset-0 bg-black flex items-center justify-center">
      <Emulator
        uri={uri}
        muted
        view="webrtc"
        poll={true}
        onError={(err: unknown) => {
          console.warn(`[${name}] WebRTC error`, err);
          setErrored(true);
          onError?.();
        }}
      />
    </div>
  );
}
