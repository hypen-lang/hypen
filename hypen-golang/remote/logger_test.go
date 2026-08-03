package remote

import (
	"bytes"
	"strings"
	"sync"
	"testing"

	core "github.com/hypen-space/core"
)

type capturingHandler struct {
	mu   sync.Mutex
	tags []string
	msgs []string
}

func (h *capturingHandler) add(tag, format string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tags = append(h.tags, tag)
	h.msgs = append(h.msgs, format)
}

func (h *capturingHandler) Debug(tag, format string, args ...any) { h.add(tag, format) }
func (h *capturingHandler) Info(tag, format string, args ...any)  { h.add(tag, format) }
func (h *capturingHandler) Warn(tag, format string, args ...any)  { h.add(tag, format) }
func (h *capturingHandler) Error(tag, format string, args ...any) { h.add(tag, format) }

func (h *capturingHandler) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.tags)
}

// Remote logs should reach a core.LogHandler so one handler covers the whole SDK.
func TestRemoteLogsRouteToCoreHandler(t *testing.T) {
	globalMu.RLock()
	prevLevel, prevOutput := globalLevel, globalOutput
	globalMu.RUnlock()
	prevHandler := core.GetLogHandler()
	t.Cleanup(func() {
		globalMu.Lock()
		globalLevel, globalOutput = prevLevel, prevOutput
		globalMu.Unlock()
		core.SetLogHandler(prevHandler)
	})

	var buf bytes.Buffer
	SetLogOutput(&buf)
	SetLogLevel(LogLevelDebug)

	h := &capturingHandler{}
	core.SetLogHandler(h)

	log := NewLogger("Remote:Test")
	log.Debug("connected to %s", "peer")
	log.Error("dropped")

	if h.count() != 2 {
		t.Fatalf("expected 2 messages routed to the core handler, got %d", h.count())
	}
	if h.tags[0] != "Remote:Test" {
		t.Errorf("tag = %q, want %q", h.tags[0], "Remote:Test")
	}
	if h.msgs[0] != "connected to %s" {
		t.Errorf("format = %q, want the raw format string", h.msgs[0])
	}
	if buf.Len() != 0 {
		t.Errorf("writer received output while handler installed: %q", buf.String())
	}

	// Removing the handler restores the writer path.
	core.SetLogHandler(nil)
	log.Error("back to writer")
	if !strings.Contains(buf.String(), "back to writer") {
		t.Errorf("writer did not resume: %q", buf.String())
	}
}

// The remote package keeps its own level filter, independent of the handler.
func TestRemoteHandlerRespectsRemoteLevel(t *testing.T) {
	globalMu.RLock()
	prevLevel, prevOutput := globalLevel, globalOutput
	globalMu.RUnlock()
	prevHandler := core.GetLogHandler()
	t.Cleanup(func() {
		globalMu.Lock()
		globalLevel, globalOutput = prevLevel, prevOutput
		globalMu.Unlock()
		core.SetLogHandler(prevHandler)
	})

	SetLogLevel(LogLevelError)
	h := &capturingHandler{}
	core.SetLogHandler(h)

	log := NewLogger("Remote:Test")
	log.Debug("filtered")
	log.Info("filtered")
	log.Error("kept")

	if h.count() != 1 {
		t.Fatalf("expected 1 message past the Error filter, got %d", h.count())
	}
	if h.msgs[0] != "kept" {
		t.Errorf("msg = %q, want %q", h.msgs[0], "kept")
	}
}
