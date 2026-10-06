package core

import (
	"bytes"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// recordedLog is one message captured by testHandler.
type recordedLog struct {
	Level  LogLevel
	Tag    string
	Format string
	Args   []any
}

// testHandler is a concurrency-safe LogHandler that records everything it gets.
type testHandler struct {
	mu      sync.Mutex
	records []recordedLog
}

func (h *testHandler) record(level LogLevel, tag, format string, args []any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, recordedLog{Level: level, Tag: tag, Format: format, Args: args})
}

func (h *testHandler) Debug(tag, format string, args ...any) {
	h.record(LogLevelDebug, tag, format, args)
}
func (h *testHandler) Info(tag, format string, args ...any) {
	h.record(LogLevelInfo, tag, format, args)
}
func (h *testHandler) Warn(tag, format string, args ...any) {
	h.record(LogLevelWarn, tag, format, args)
}
func (h *testHandler) Error(tag, format string, args ...any) {
	h.record(LogLevelError, tag, format, args)
}

func (h *testHandler) snapshot() []recordedLog {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]recordedLog(nil), h.records...)
}

func (h *testHandler) len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.records)
}

// restoreGlobalLogging snapshots and restores the package-level logger config so
// tests do not leak state into each other.
func restoreGlobalLogging(t *testing.T) {
	t.Helper()
	globalMu.RLock()
	level, output, handler := globalLevel, globalOutput, globalHandler
	globalMu.RUnlock()
	t.Cleanup(func() {
		globalMu.Lock()
		globalLevel, globalOutput, globalHandler = level, output, handler
		globalMu.Unlock()
	})
}

func TestLoggerDefaultWriterPath(t *testing.T) {
	restoreGlobalLogging(t)

	var buf bytes.Buffer
	SetLogOutput(&buf)
	SetLogLevel(LogLevelDebug)

	log := NewLogger("Test")
	log.Debug("count=%d", 7)
	log.Error("boom: %s", "oops")

	out := buf.String()
	if !strings.Contains(out, "[Test] DEBUG: count=7") {
		t.Errorf("missing formatted debug line, got %q", out)
	}
	if !strings.Contains(out, "[Test] ERROR: boom: oops") {
		t.Errorf("missing formatted error line, got %q", out)
	}
}

func TestSetLogHandlerReceivesAllLevels(t *testing.T) {
	restoreGlobalLogging(t)

	var buf bytes.Buffer
	SetLogOutput(&buf)
	SetLogLevel(LogLevelDebug)

	h := &testHandler{}
	SetLogHandler(h)

	log := NewLogger("Engine")
	log.Debug("d %d", 1)
	log.Info("i %d", 2)
	log.Warn("w %d", 3)
	log.Error("e %d", 4)

	records := h.snapshot()
	if len(records) != 4 {
		t.Fatalf("expected 4 records, got %d", len(records))
	}

	wantLevels := []LogLevel{LogLevelDebug, LogLevelInfo, LogLevelWarn, LogLevelError}
	wantFormats := []string{"d %d", "i %d", "w %d", "e %d"}
	for i, rec := range records {
		if rec.Level != wantLevels[i] {
			t.Errorf("record %d: level = %v, want %v", i, rec.Level, wantLevels[i])
		}
		if rec.Tag != "Engine" {
			t.Errorf("record %d: tag = %q, want %q", i, rec.Tag, "Engine")
		}
		// The handler receives the raw format string and args, not a rendered line.
		if rec.Format != wantFormats[i] {
			t.Errorf("record %d: format = %q, want %q", i, rec.Format, wantFormats[i])
		}
		if len(rec.Args) != 1 || rec.Args[0] != i+1 {
			t.Errorf("record %d: args = %v, want [%d]", i, rec.Args, i+1)
		}
	}

	// The handler replaces the writer path entirely.
	if buf.Len() != 0 {
		t.Errorf("writer received output while handler installed: %q", buf.String())
	}
}

func TestSetLogHandlerNilRestoresWriter(t *testing.T) {
	restoreGlobalLogging(t)

	var buf bytes.Buffer
	SetLogOutput(&buf)
	SetLogLevel(LogLevelDebug)

	h := &testHandler{}
	SetLogHandler(h)
	log := NewLogger("Test")
	log.Info("handled")

	if got := GetLogHandler(); got == nil {
		t.Fatal("GetLogHandler returned nil after SetLogHandler")
	}

	SetLogHandler(nil)
	if got := GetLogHandler(); got != nil {
		t.Fatalf("GetLogHandler = %v after SetLogHandler(nil), want nil", got)
	}

	log.Info("written")

	if h.len() != 1 {
		t.Errorf("handler kept receiving after removal: %d records", h.len())
	}
	out := buf.String()
	if strings.Contains(out, "handled") {
		t.Errorf("writer received the handled message: %q", out)
	}
	if !strings.Contains(out, "[Test] INFO: written") {
		t.Errorf("writer did not resume after SetLogHandler(nil): %q", out)
	}
}

func TestLogHandlerRespectsGlobalLevelFilter(t *testing.T) {
	restoreGlobalLogging(t)

	h := &testHandler{}
	SetLogHandler(h)
	SetLogLevel(LogLevelWarn)

	log := NewLogger("Filtered")
	log.Debug("nope")
	log.Info("nope")
	log.Warn("yes")
	log.Error("yes")

	records := h.snapshot()
	if len(records) != 2 {
		t.Fatalf("expected 2 records past the Warn filter, got %d (%v)", len(records), records)
	}
	if records[0].Level != LogLevelWarn || records[1].Level != LogLevelError {
		t.Errorf("unexpected levels: %v, %v", records[0].Level, records[1].Level)
	}

	// LogLevelNone silences the handler completely.
	SetLogLevel(LogLevelNone)
	log.Error("silenced")
	if h.len() != 2 {
		t.Errorf("handler received a message at LogLevelNone: %d records", h.len())
	}
}

func TestLogHandlerRespectsPerLoggerLevel(t *testing.T) {
	restoreGlobalLogging(t)

	h := &testHandler{}
	SetLogHandler(h)
	SetLogLevel(LogLevelDebug)

	log := NewLogger("Local")
	log.SetLevel(LogLevelError)
	log.Debug("nope")
	log.Warn("nope")
	log.Error("yes")

	records := h.snapshot()
	if len(records) != 1 {
		t.Fatalf("expected 1 record past the per-logger filter, got %d", len(records))
	}
	if records[0].Level != LogLevelError || records[0].Format != "yes" {
		t.Errorf("unexpected record: %+v", records[0])
	}
}

func TestLogHandlerOverridesPerLoggerOutput(t *testing.T) {
	restoreGlobalLogging(t)

	SetLogLevel(LogLevelDebug)
	var local bytes.Buffer
	log := NewLogger("Overridden")
	log.SetOutput(&local)

	// Without a handler, the per-logger writer is used.
	log.Info("to writer")
	if !strings.Contains(local.String(), "to writer") {
		t.Fatalf("per-logger writer not used: %q", local.String())
	}

	// With a handler, it takes precedence over the per-logger writer too.
	h := &testHandler{}
	SetLogHandler(h)
	local.Reset()
	log.Info("to handler")

	if h.len() != 1 {
		t.Errorf("handler did not receive message from logger with local output")
	}
	if local.Len() != 0 {
		t.Errorf("per-logger writer received output while handler installed: %q", local.String())
	}
}

func TestLogHandlerFuncAdapter(t *testing.T) {
	restoreGlobalLogging(t)

	SetLogLevel(LogLevelDebug)

	var mu sync.Mutex
	var lines []string
	SetLogHandler(LogHandlerFunc(func(level LogLevel, tag, format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, fmt.Sprintf("%d|%s|%s", level, tag, fmt.Sprintf(format, args...)))
	}))

	log := NewLogger("Func")
	log.Debug("hello %s", "world")
	log.Error("code=%d", 42)

	mu.Lock()
	defer mu.Unlock()
	want := []string{
		fmt.Sprintf("%d|Func|hello world", LogLevelDebug),
		fmt.Sprintf("%d|Func|code=42", LogLevelError),
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d: %v", len(lines), len(want), lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("line %d = %q, want %q", i, lines[i], want[i])
		}
	}
}

func TestLogHandlerChildLoggerTag(t *testing.T) {
	restoreGlobalLogging(t)

	h := &testHandler{}
	SetLogHandler(h)
	SetLogLevel(LogLevelDebug)

	NewLogger("Engine").Child("WASM").Debug("init")

	records := h.snapshot()
	if len(records) != 1 || records[0].Tag != "Engine:WASM" {
		t.Fatalf("unexpected records: %+v", records)
	}
}

// TestLogHandlerConcurrentSwap exercises the mutex discipline: handlers are
// swapped while other goroutines log. Run with -race for full value.
func TestLogHandlerConcurrentSwap(t *testing.T) {
	restoreGlobalLogging(t)

	SetLogLevel(LogLevelDebug)
	SetLogOutput(&syncWriter{})

	h1 := &testHandler{}
	h2 := &testHandler{}

	var wg sync.WaitGroup
	const iterations = 200

	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			log := NewLogger(fmt.Sprintf("W%d", id))
			for i := 0; i < iterations; i++ {
				log.Info("msg %d", i)
			}
		}(w)
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			switch i % 3 {
			case 0:
				SetLogHandler(h1)
			case 1:
				SetLogHandler(h2)
			default:
				SetLogHandler(nil)
			}
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			_ = GetLogHandler()
			SetLogLevel(LogLevelDebug)
		}
	}()

	wg.Wait()

	// Messages may land on h1, h2 or the writer depending on scheduling — the
	// point of the stress above is that the swap is race-free. What must hold
	// deterministically is that the logger still works after the churn.
	_ = h1.len()
	_ = h2.len()

	final := &testHandler{}
	SetLogHandler(final)
	NewLogger("After").Warn("still routed")

	if final.len() != 1 {
		t.Fatalf("handler broken after concurrent swaps: %d records", final.len())
	}
	if got := final.snapshot()[0]; got.Tag != "After" || got.Format != "still routed" {
		t.Errorf("unexpected record after concurrent swaps: %+v", got)
	}
}

// syncWriter is a no-op io.Writer safe for concurrent use.
type syncWriter struct{ mu sync.Mutex }

func (w *syncWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(p), nil
}
