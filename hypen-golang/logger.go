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

// Logger provides tagged logging with configurable levels.
type Logger struct {
	tag    string
	level  LogLevel
	output io.Writer
	mu     sync.RWMutex
}

// Global configuration
var (
	globalLevel                = LogLevelError // Default to error-only in production
	globalOutput    io.Writer = os.Stderr
	globalMu     sync.RWMutex
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
