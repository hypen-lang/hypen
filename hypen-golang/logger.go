// Package core provides a configurable debug logging system.
package core

import (
	"fmt"
	"io"
	"os"
	"sync"
)

// LogLevel represents the severity level for logging.
type LogLevel int

const (
	// LogLevelDebug shows all log messages.
	LogLevelDebug LogLevel = iota
	// LogLevelInfo shows info, warn, and error messages.
	LogLevelInfo
	// LogLevelWarn shows warn and error messages.
	LogLevelWarn
	// LogLevelError shows only error messages.
	LogLevelError
	// LogLevelNone disables all logging.
	LogLevelNone
)

// LogHandler receives log messages that pass the level filter, allowing Hypen
// logs to be routed into an application's own logging system (slog, zap,
// logrus, ...) instead of being written to an io.Writer.
//
// The message is delivered unformatted — the format string and its arguments
// are passed through separately so structured handlers can keep the template
// intact. Handlers that want the rendered line can call
// fmt.Sprintf(format, args...).
//
// Level filtering is applied by the SDK before the handler is called, so
// handlers never need to re-check the level.
//
// Handlers may be invoked concurrently from multiple goroutines and must be
// safe for concurrent use.
type LogHandler interface {
	Debug(tag, format string, args ...any)
	Info(tag, format string, args ...any)
	Warn(tag, format string, args ...any)
	Error(tag, format string, args ...any)
}

// LogHandlerFunc adapts a single function into a LogHandler, in the style of
// http.HandlerFunc. The level of the message is passed as the first argument.
//
//	core.SetLogHandler(core.LogHandlerFunc(
//		func(level core.LogLevel, tag, format string, args ...any) {
//			slog.Info(fmt.Sprintf(format, args...), "tag", tag, "level", level)
//		},
//	))
type LogHandlerFunc func(level LogLevel, tag, format string, args ...any)

// Debug implements LogHandler.
func (f LogHandlerFunc) Debug(tag, format string, args ...any) {
	f(LogLevelDebug, tag, format, args...)
}

// Info implements LogHandler.
func (f LogHandlerFunc) Info(tag, format string, args ...any) {
	f(LogLevelInfo, tag, format, args...)
}

// Warn implements LogHandler.
func (f LogHandlerFunc) Warn(tag, format string, args ...any) {
	f(LogLevelWarn, tag, format, args...)
}

// Error implements LogHandler.
func (f LogHandlerFunc) Error(tag, format string, args ...any) {
	f(LogLevelError, tag, format, args...)
}

// Logger provides tagged logging with configurable levels.
type Logger struct {
	tag    string
	level  LogLevel
	output io.Writer
	mu     sync.RWMutex
}

// Global configuration
var (
	globalLevel              = LogLevelError // Default to error-only in production
	globalOutput  io.Writer  = os.Stderr
	globalHandler LogHandler // nil = write to globalOutput
	globalMu      sync.RWMutex
)

// SetDebugMode enables or disables debug logging globally.
// When enabled, all debug logs will be shown.
// When disabled, only error logs will be shown.
func SetDebugMode(enabled bool) {
	globalMu.Lock()
	defer globalMu.Unlock()
	if enabled {
		globalLevel = LogLevelDebug
	} else {
		globalLevel = LogLevelError
	}
}

// SetLogLevel sets the global minimum log level.
func SetLogLevel(level LogLevel) {
	globalMu.Lock()
	defer globalMu.Unlock()
	globalLevel = level
}

// GetLogLevel returns the current global log level.
func GetLogLevel() LogLevel {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return globalLevel
}

// SetLogOutput sets the global log output writer.
func SetLogOutput(w io.Writer) {
	globalMu.Lock()
	defer globalMu.Unlock()
	globalOutput = w
}

// SetLogHandler installs a custom log handler. Every message that passes the
// level filter — global or per-logger — is delivered to the handler instead of
// being written to an output writer, including messages from loggers with a
// per-logger SetOutput.
//
// Passing nil removes the handler and restores the default writer-based
// behaviour.
//
//	core.SetLogHandler(myHandler)  // route Hypen logs into my logging system
//	core.SetLogHandler(nil)        // back to writing to the output writer
func SetLogHandler(h LogHandler) {
	globalMu.Lock()
	defer globalMu.Unlock()
	globalHandler = h
}

// GetLogHandler returns the currently installed log handler, or nil when logs
// are written to the output writer.
func GetLogHandler() LogHandler {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return globalHandler
}

// IsDebugMode returns true if debug logging is enabled.
func IsDebugMode() bool {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return globalLevel == LogLevelDebug
}

// NewLogger creates a new logger with the given tag.
func NewLogger(tag string) *Logger {
	return &Logger{
		tag:    tag,
		level:  -1, // Use global level
		output: nil, // Use global output
	}
}

// SetLevel sets the log level for this logger (overrides global).
func (l *Logger) SetLevel(level LogLevel) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.level = level
}

// SetOutput sets the output writer for this logger (overrides global).
func (l *Logger) SetOutput(w io.Writer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.output = w
}

func (l *Logger) shouldLog(level LogLevel) bool {
	l.mu.RLock()
	localLevel := l.level
	l.mu.RUnlock()

	if localLevel >= 0 {
		return level >= localLevel
	}

	globalMu.RLock()
	defer globalMu.RUnlock()
	return level >= globalLevel
}

func (l *Logger) getOutput() io.Writer {
	l.mu.RLock()
	localOutput := l.output
	l.mu.RUnlock()

	if localOutput != nil {
		return localOutput
	}

	globalMu.RLock()
	defer globalMu.RUnlock()
	return globalOutput
}

func (l *Logger) log(level LogLevel, levelStr string, format string, args ...any) {
	if !l.shouldLog(level) {
		return
	}
	// A handler, when installed, replaces the writer path entirely. It is
	// invoked outside the lock so handlers may safely call back into the SDK.
	if h := GetLogHandler(); h != nil {
		switch level {
		case LogLevelDebug:
			h.Debug(l.tag, format, args...)
		case LogLevelInfo:
			h.Info(l.tag, format, args...)
		case LogLevelWarn:
			h.Warn(l.tag, format, args...)
		case LogLevelError:
			h.Error(l.tag, format, args...)
		case LogLevelNone:
			// Never emitted: LogLevelNone is a filter threshold, not a message level.
		}
		return
	}
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(l.getOutput(), "[%s] %s: %s\n", l.tag, levelStr, msg)
}

// Debug logs a debug message.
func (l *Logger) Debug(format string, args ...any) {
	l.log(LogLevelDebug, "DEBUG", format, args...)
}

// Info logs an info message.
func (l *Logger) Info(format string, args ...any) {
	l.log(LogLevelInfo, "INFO", format, args...)
}

// Warn logs a warning message.
func (l *Logger) Warn(format string, args ...any) {
	l.log(LogLevelWarn, "WARN", format, args...)
}

// Error logs an error message.
func (l *Logger) Error(format string, args ...any) {
	l.log(LogLevelError, "ERROR", format, args...)
}

// Child creates a child logger with a sub-tag.
func (l *Logger) Child(subTag string) *Logger {
	return NewLogger(l.tag + ":" + subTag)
}

// Framework loggers for different components
var (
	LogEngine    = NewLogger("Engine")
	LogRouter    = NewLogger("Router")
	LogState     = NewLogger("State")
	LogEvents    = NewLogger("Events")
	LogRemote    = NewLogger("Remote")
	LogRenderer  = NewLogger("Renderer")
	LogModule    = NewLogger("Module")
	LogLifecycle = NewLogger("Lifecycle")
	LogLoader    = NewLogger("Loader")
	LogContext   = NewLogger("Context")
	LogDiscovery = NewLogger("Discovery")
)
