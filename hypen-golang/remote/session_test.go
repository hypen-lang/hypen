// Tests for the transport-agnostic RemoteSession primitives:
//   - CreateSession(transport) drives a session without net/http
//   - ChannelTransport delivers outgoing messages on a Go channel
//   - CreateHandler returns a framework-agnostic handler trio
package remote

import (
	"encoding/json"
	"testing"
	"time"
)

func TestPrepare_RequiresModuleAndUI(t *testing.T) {
	s := NewRemoteServer()
	if err := s.Prepare(); err == nil {
		t.Fatal("Prepare should fail without module")
	}
	s.WithState("Counter", map[string]any{"count": 0})
	if err := s.Prepare(); err == nil {
		t.Fatal("Prepare should fail without UI")
	}
	s.UI("Text(\"hi\")")
	if err := s.Prepare(); err != nil {
		t.Fatalf("Prepare should succeed: %v", err)
	}
	// Idempotent.
	if err := s.Prepare(); err != nil {
		t.Fatalf("Prepare should be idempotent: %v", err)
	}
}

func TestCreateSession_FailsBeforePrepare(t *testing.T) {
	s := NewRemoteServer()
	if _, err := s.CreateSession(NewChannelTransport(8)); err == nil {
		t.Fatal("CreateSession should fail before Prepare")
	}
}

func TestCreateSession_HelloProducesAckAndInitialTree(t *testing.T) {
	s := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		UI(`Text("hi")`)
	if err := s.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	transport := NewChannelTransport(16)
	// Disable legacy hello grace so the test is deterministic.
	sess, err := s.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}

	var sawAck, sawInitial bool
	deadline := time.After(2 * time.Second)
collect:
	for {
		select {
		case msg, ok := <-transport.Out():
			if !ok {
				break collect
			}
			switch msg.GetType() {
			case MessageTypeSessionAck:
				ack, _ := msg.(*SessionAckMessage)
				if ack == nil || !ack.IsNew || ack.SessionID == "" {
					t.Fatalf("bad sessionAck: %+v", msg)
				}
				sawAck = true
			case MessageTypeInitialTree:
				init, _ := msg.(*InitialTreeMessage)
				if init == nil {
					t.Fatalf("expected *InitialTreeMessage, got %T", msg)
				}
				sawInitial = true
				break collect
			}
		case <-deadline:
			t.Fatal("timed out waiting for ack + initialTree")
		}
	}
	if !sawAck || !sawInitial {
		t.Fatalf("missing messages — ack=%v initial=%v", sawAck, sawInitial)
	}

	if err := sess.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
}

func TestCreateHandler_WiresReceiveAndDestroy(t *testing.T) {
	s := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		UI(`Text("hi")`)
	if err := s.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	handle := s.CreateHandler()

	transport := NewChannelTransport(16)
	h, err := handle(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("handle: %v", err)
	}
	if h.Session == nil || h.Receive == nil || h.Destroy == nil {
		t.Fatal("missing handler fields")
	}
	if h.Session.HelloReceived() {
		t.Fatal("should not yet have received hello")
	}
	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := h.Receive(hello); err != nil {
		t.Fatalf("Receive: %v", err)
	}
	if !h.Session.HelloReceived() {
		t.Fatal("should have received hello")
	}
	if err := h.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	// Double-destroy is a no-op.
	if err := h.Destroy(); err != nil {
		t.Fatalf("Destroy (2): %v", err)
	}
}

func TestChannelTransport_CloseDrainsOut(t *testing.T) {
	t_ := NewChannelTransport(4)
	if err := t_.Send(&SessionAckMessage{
		Type: MessageTypeSessionAck, SessionID: "s1", IsNew: true,
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	t_.Close(0, "")
	n := 0
	for msg := range t_.Out() {
		if msg == nil {
			t.Fatal("unexpected nil msg")
		}
		n++
	}
	if n != 1 {
		t.Fatalf("expected 1 drained msg, got %d", n)
	}
	// Second close is a no-op.
	if err := t_.Close(0, ""); err != nil {
		t.Fatalf("close again: %v", err)
	}
}
