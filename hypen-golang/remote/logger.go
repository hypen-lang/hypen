package remote

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

// Global configuration
var (
	globalLevel                = LogLevelError // Default to error-only
	globalOutput    io.Writer = os.Stderr
	globalMu     sync.RWMutex
)

// SetDebugMode enables or disables debug logging.
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

// Logger provides tagged logging with configurable levels.
type Logger struct {
	tag string
}

// NewLogger creates a new logger with the given tag.
func NewLogger(tag string) *Logger {
	return &Logger{tag: tag}
}

func (l *Logger) shouldLog(level LogLevel) bool {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return level >= globalLevel
}

func (l *Logger) log(level LogLevel, levelStr string, format string, args ...any) {
	if !l.shouldLog(level) {
		return
	}
	globalMu.RLock()
	output := globalOutput
	globalMu.RUnlock()
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(output, "[%s] %s: %s\n", l.tag, levelStr, msg)
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

// SetLogOutput sets the global log output writer.
func SetLogOutput(w io.Writer) {
	globalMu.Lock()
	defer globalMu.Unlock()
	globalOutput = w
}

// Framework loggers for remote components
var (
	logServer = NewLogger("Remote:Server")
	logClient = NewLogger("Remote:Client")
)
