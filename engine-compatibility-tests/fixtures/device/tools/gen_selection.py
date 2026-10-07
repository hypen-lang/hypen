#!/usr/bin/env python3
"""Generates fixtures/device/conformance/selection.json."""
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "conformance")


def o(name, *versions):
    return {"name": name, "versions": list(versions)}


def s(name, version):
    return {"name": name, "version": version}


def hello(caps, pv=(1,), binary=True):
    return {"protocolVersions": list(pv), "binary": binary, "capabilities": caps}


def ack(caps, binary=True, pv=1):
    return {"protocolVersion": pv, "binary": binary, "capabilities": caps}


CORE = o("core.capabilities", 1)
cases = []


def C(name, description, server, hello_, expect, server_binary=True, server_pv=None):
    case = {"name": name, "description": description, "serverCapabilities": server,
            "serverBinary": server_binary, "hello": hello_, "expect": expect}
    if server_pv is not None:
        case["serverProtocolVersions"] = server_pv
    cases.append(case)


C("highest-common-revision",
  "Newer client offers gallery.pick 1 and 2; the server implements 1: revision 1 is pinned.",
  [CORE, o("gallery.pick", 1)],
  hello([CORE, o("gallery.pick", 1, 2)]),
  ack([s("core.capabilities", 1), s("gallery.pick", 1)]))
C("names-on-one-side-only-are-dropped",
  "Client-only and server-only names are excluded from the intersection; ack order follows the server.",
  [CORE, o("permission.query", 1), o("mic.record", 1), o("gallery.pick", 1)],
  hello([o("gallery.pick", 1), CORE, o("file.save", 1)]),
  ack([s("core.capabilities", 1), s("gallery.pick", 1)]))
C("highest-common-protocol-version",
  "Highest protocol version both sides list. Selection is a pure function of its inputs: this pins "
  "the algorithm (3 beats 1) for a server that claims protocol versions 1 and 3, independent of "
  "which protocol versions any registry implements today.",
  [CORE],
  hello([CORE], pv=(1, 2, 3)),
  ack([s("core.capabilities", 1)], pv=3),
  server_pv=[1, 3])
C("no-common-protocol-disables-device",
  "No common protocol version: device access disabled (null), UI-only operation continues.",
  [CORE],
  hello([CORE], pv=(2,)),
  None)
C("binary-false-on-server-omits-binary-plane-revisions",
  "Rule (c): the negotiated binary is false, so binaryUpload/binaryDownload revisions are not selectable; JSON-plane and plane-less capabilities remain.",
  [CORE, o("bluetooth.scan", 1), o("file.pick", 1), o("file.save", 1), o("gallery.pick", 1),
   o("mic.record", 1), o("permission.query", 1)],
  hello([CORE, o("bluetooth.scan", 1), o("file.pick", 1), o("file.save", 1), o("gallery.pick", 1),
         o("mic.record", 1), o("permission.query", 1)]),
  ack([s("core.capabilities", 1), s("bluetooth.scan", 1), s("permission.query", 1)], binary=False),
  server_binary=False)
C("binary-false-on-client-omits-binary-plane-revisions",
  "Rule (c) applies whichever side lacks binary.",
  [CORE, o("gallery.pick", 1), o("permission.request", 1)],
  hello([CORE, o("gallery.pick", 1), o("permission.request", 1)], binary=False),
  ack([s("core.capabilities", 1), s("permission.request", 1)], binary=False))
C("core-capabilities-missing-from-hello-disables-device",
  "Rule (b): core.capabilities revision 1 is mandatory on every enabled device connection.",
  [CORE, o("permission.query", 1)],
  hello([o("permission.query", 1)]),
  None)
C("core-capabilities-missing-on-server-disables-device",
  "Rule (b), server side.",
  [o("permission.query", 1)],
  hello([CORE, o("permission.query", 1)]),
  None)
C("core-capabilities-v1-not-mutual-disables-device",
  "Rule (b): a client offering only a newer core.capabilities revision leaves revision 1 outside the intersection.",
  [CORE, o("permission.query", 1)],
  hello([o("core.capabilities", 2), o("permission.query", 1)]),
  None)
C("capability-version-zero-is-never-selected",
  "A hello offering the reserved revision 0 fails handshake-v1 (versions are >= 1), and a hello.device "
  "that fails validation disables device access (decision D7: select_device_ack validates the hello "
  "first).",
  [CORE, o("permission.query", 0, 1)],
  hello([CORE, o("permission.query", 0)]),
  None)
C("protocol-version-zero-is-never-selected",
  "A hello listing the reserved protocol version 0 fails handshake-v1 and disables device access "
  "(decision D7), even though 1 would be common.",
  [CORE],
  hello([CORE], pv=(0, 1)),
  None,
  server_pv=[0, 1])
C("protocol-version-zero-only-disables-device",
  "Invalid hello (reserved protocol version 0): device access disabled.",
  [CORE],
  hello([CORE], pv=(0,)),
  None,
  server_pv=[0, 1])
C("server-side-version-zero-is-filtered",
  "Rule (a) on the server side: the server's own reserved 0 (protocol or revision) is never "
  "selected; only the mutual 1s are.",
  [CORE, o("permission.query", 0, 1)],
  hello([CORE, o("permission.query", 1)]),
  ack([s("core.capabilities", 1), s("permission.query", 1)]),
  server_pv=[0, 1])
C("server-only-version-zero-omits-the-capability",
  "A server offering only the reserved revision 0 for a name has nothing selectable for it.",
  [CORE, o("permission.query", 0)],
  hello([CORE, o("permission.query", 1)]),
  ack([s("core.capabilities", 1)]))
C("invalid-hello-too-many-protocol-versions-disables-device",
  "handshake-v1 bounds protocolVersions to 8 entries; a longer list fails validation and disables "
  "device access.",
  [CORE],
  hello([CORE], pv=tuple(range(1, 10))),
  None)
C("invalid-hello-empty-capability-name-disables-device",
  "handshake-v1 requires 1..128 code-point names; an empty name fails validation and disables "
  "device access.",
  [CORE],
  hello([CORE, o("", 1)]),
  None)
C("duplicate-server-entries-first-wins",
  "Duplicate names in the server's own advertisement: the first entry wins and later ones are "
  "ignored, never merged (decision D7). The first permission.query entry offers only revision 2, "
  "which the registry does not declare, so permission.query is omitted even though a later entry "
  "offers 1.",
  [CORE, o("permission.query", 2), o("permission.query", 1)],
  hello([CORE, o("permission.query", 1)]),
  ack([s("core.capabilities", 1)]))
C("duplicate-server-entries-first-wins-selectable",
  "First-wins, the other way round: the first entry offers 1 and is selected; the later entry is "
  "ignored.",
  [CORE, o("permission.query", 1), o("permission.query", 2)],
  hello([CORE, o("permission.query", 1, 2)]),
  ack([s("core.capabilities", 1), s("permission.query", 1)]))
C("canonically-equivalent-names-are-distinct",
  "Names compare by exact code points, never Unicode canonical equivalence: U+00E9 and "
  "U+0065 U+0301 are two different names, so this hello has no duplicate and device access stays "
  "enabled (neither name is implemented by the server).",
  [CORE, o("\u00e9", 1)],
  hello([CORE, o("\u00e9", 1), o("e\u0301", 1)]),
  ack([s("core.capabilities", 1)]))
C("duplicate-capability-name-in-hello-disables-device",
  "Rule (d): conflicting offers for one name are never resolved by picking one.",
  [CORE, o("gallery.pick", 1)],
  hello([CORE, o("gallery.pick", 1), o("gallery.pick", 1, 2)]),
  None)
C("duplicate-protocol-version-in-hello-disables-device",
  "Rule (d).",
  [CORE],
  hello([CORE], pv=(1, 1)),
  None)
C("duplicate-version-in-offer-disables-device",
  "Rule (d), including for a name the server does not implement.",
  [CORE],
  hello([CORE, o("client.only", 1, 1)]),
  None)
C("revision-absent-from-registry-is-never-selected",
  "A revision the server's registry does not declare has no schema on the server, so it is never selected even if both sides list it.",
  [CORE, o("gallery.pick", 1, 2)],
  hello([CORE, o("gallery.pick", 1, 2)]),
  ack([s("core.capabilities", 1), s("gallery.pick", 1)]))
C("only-core-in-common",
  "An otherwise empty intersection still enables device access with the control stream alone.",
  [CORE, o("mic.record", 1)],
  hello([CORE, o("gallery.pick", 1)]),
  ack([s("core.capabilities", 1)]))

# Round 3: camera.capture@1 (binaryUpload) and bluetooth.select@1 (no data plane).
ROUND3 = ["bluetooth.scan", "bluetooth.select", "camera.capture", "file.pick", "file.save",
          "gallery.pick", "mic.record", "permission.query", "permission.request"]
C("full-registry-selects-every-revision",
  "Both sides implement the whole round-3 registry with binary: every capability is selected at "
  "revision 1, in the server's advertisement order.",
  [CORE] + [o(n, 1) for n in ROUND3],
  hello([CORE] + [o(n, 1) for n in reversed(ROUND3)]),
  ack([s("core.capabilities", 1)] + [s(n, 1) for n in ROUND3]))
C("binary-false-keeps-bluetooth-select-drops-camera-capture",
  "Rule (c) on the round-3 revisions: without binary, camera.capture@1 and mic.record@1 "
  "(binaryUpload) are not selectable, while bluetooth.select@1 (no data plane: the chosen device "
  "comes back as JSON) and the permission revisions stay.",
  [CORE, o("bluetooth.select", 1), o("camera.capture", 1), o("mic.record", 1),
   o("permission.query", 1), o("permission.request", 1)],
  hello([CORE, o("bluetooth.select", 1), o("camera.capture", 1), o("mic.record", 1),
         o("permission.query", 1), o("permission.request", 1)], binary=False),
  ack([s("core.capabilities", 1), s("bluetooth.select", 1), s("permission.query", 1),
       s("permission.request", 1)], binary=False))
C("camera-capture-newer-client-pins-revision-1",
  "A newer client offering camera.capture 1 and 2 against a server with revision 1 pins 1; a "
  "bluetooth.select offered only by the client is dropped.",
  [CORE, o("camera.capture", 1)],
  hello([CORE, o("camera.capture", 1, 2), o("bluetooth.select", 1)]),
  ack([s("core.capabilities", 1), s("camera.capture", 1)]))
C("bluetooth-select-without-bluetooth-scan",
  "bluetooth.select and bluetooth.scan are independent capabilities: a web host with Web Bluetooth "
  "offers select but not scan (scan stays native-only).",
  [CORE, o("bluetooth.scan", 1), o("bluetooth.select", 1)],
  hello([CORE, o("bluetooth.select", 1)]),
  ack([s("core.capabilities", 1), s("bluetooth.select", 1)]))

doc = {
    "description": (
        "Table-driven handshake selection cases (RFC 001 §2.2) pinning the reference "
        "select_device_ack in every SDK. Inputs: `hello` (hello.device), the server's "
        "`serverCapabilities` advertisement, `serverBinary`, and optional "
        "`serverProtocolVersions` (default [1]). `expect` is the sessionAck.device "
        "object, or null when device access is disabled. The hello is validated first: a "
        "hello.device failing handshake-v1 (or repeating a name or value) disables device access. "
        "Duplicate server entries: first wins. Names compare by exact code points. Revision data "
        "planes and the set of declared revisions come from registry-v1.json."
    ),
    "cases": cases,
}
with open(os.path.join(ROOT, "selection.json"), "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print(len(cases), "selection cases")
