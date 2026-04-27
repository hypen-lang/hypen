package core

import "fmt"

// EngineErrorCode identifies the category of an engine error.
// These codes correspond to the EngineError variants in the Rust engine.
type EngineErrorCode int

const (
	// ErrParse indicates a failure to parse Hypen DSL source code.
	ErrParse EngineErrorCode = iota + 1
	// ErrComponentNotFound indicates a referenced component was not found in the registry.
	ErrComponentNotFound
	// ErrRender indicates an error during rendering or reconciliation.
	ErrRender
	// ErrActionNotFound indicates no handler was registered for the dispatched action.
	ErrActionNotFound
	// ErrState indicates an error related to state operations (invalid patch, deserialization failure).
	ErrState
	// ErrExpression indicates an error evaluating an expression or template string.
	ErrExpression
	// ErrNotInitialized indicates the engine has not been initialized.
	ErrNotInitialized
)

// String returns the name of the error code.
func (c EngineErrorCode) String() string {
	switch c {
	case ErrParse:
		return "ParseError"
	case ErrComponentNotFound:
		return "ComponentNotFound"
	case ErrRender:
		return "RenderError"
	case ErrActionNotFound:
		return "ActionNotFound"
	case ErrState:
		return "StateError"
	case ErrExpression:
		return "ExpressionError"
	case ErrNotInitialized:
		return "NotInitialized"
	default:
		return "Unknown"
	}
}

// EngineError is a structured error type for Hypen Engine operations.
// SDK consumers can inspect the Code field to determine the error category
// and handle different failure modes appropriately.
type EngineError struct {
	// Code identifies the category of error.
	Code EngineErrorCode
	// Message is a human-readable description of the error.
	Message string
	// Cause is the underlying error, if any.
	Cause error
}

// Error implements the error interface.
func (e *EngineError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s (caused by: %v)", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Unwrap returns the underlying cause for errors.Is/errors.As support.
func (e *EngineError) Unwrap() error {
	return e.Cause
}

// IsEngineError checks if an error is an EngineError with the given code.
func IsEngineError(err error, code EngineErrorCode) bool {
	if ee, ok := err.(*EngineError); ok {
		return ee.Code == code
	}
	return false
}

// wasmErrorCode maps WASI FFI return codes to EngineError for a given operation context.
// WASI error codes: 0=success, 1=string/input error, 2=engine not initialized/JSON parse,
// 3=parse error/no engine, 4=not found (context-specific).
func newWasmError(operation string, code uint64) *EngineError {
	switch operation {
	case "render":
		switch code {
		case 1:
			return &EngineError{Code: ErrRender, Message: "invalid source string"}
		case 2:
			return &EngineError{Code: ErrNotInitialized, Message: "engine not initialized"}
		case 3:
			return &EngineError{Code: ErrParse, Message: "failed to parse source"}
		default:
			return &EngineError{Code: ErrRender, Message: fmt.Sprintf("render failed with code: %d", code)}
		}
	case "render_into":
		switch code {
		case 1:
			return &EngineError{Code: ErrRender, Message: "invalid source string"}
		case 2:
			return &EngineError{Code: ErrNotInitialized, Message: "engine not initialized"}
		case 3:
			return &EngineError{Code: ErrParse, Message: "failed to parse source"}
		case 4:
			return &EngineError{Code: ErrComponentNotFound, Message: "parent node not found"}
		default:
			return &EngineError{Code: ErrRender, Message: fmt.Sprintf("render_into failed with code: %d", code)}
		}
	case "update_state":
		switch code {
		case 1:
			return &EngineError{Code: ErrState, Message: "invalid state string"}
		case 2:
			return &EngineError{Code: ErrState, Message: "invalid state JSON"}
		case 3:
			return &EngineError{Code: ErrNotInitialized, Message: "engine not initialized"}
		default:
			return &EngineError{Code: ErrState, Message: fmt.Sprintf("update_state failed with code: %d", code)}
		}
	case "dispatch_action":
		switch code {
		case 1:
			return &EngineError{Code: ErrActionNotFound, Message: "invalid action string"}
		case 2:
			return &EngineError{Code: ErrActionNotFound, Message: "invalid action JSON"}
		case 3:
			return &EngineError{Code: ErrNotInitialized, Message: "engine not initialized"}
		default:
			return &EngineError{Code: ErrActionNotFound, Message: fmt.Sprintf("dispatch_action failed with code: %d", code)}
		}
	case "register_primitive":
		switch code {
		case 1:
			return &EngineError{Code: ErrRender, Message: "invalid primitive name"}
		case 2:
			return &EngineError{Code: ErrNotInitialized, Message: "engine not initialized"}
		default:
			return &EngineError{Code: ErrRender, Message: fmt.Sprintf("register_primitive failed with code: %d", code)}
		}
	case "register_component":
		switch code {
		case 1:
			return &EngineError{Code: ErrRender, Message: "invalid component string"}
		case 2:
			return &EngineError{Code: ErrNotInitialized, Message: "engine not initialized"}
		case 3:
			return &EngineError{Code: ErrParse, Message: "failed to parse component source"}
		default:
			return &EngineError{Code: ErrRender, Message: fmt.Sprintf("register_component failed with code: %d", code)}
		}
	case "parse":
		switch code {
		case 1:
			return &EngineError{Code: ErrParse, Message: "invalid source string"}
		case 2:
			return &EngineError{Code: ErrNotInitialized, Message: "engine not initialized"}
		case 3:
			return &EngineError{Code: ErrParse, Message: "failed to parse source"}
		default:
			return &EngineError{Code: ErrParse, Message: fmt.Sprintf("parse failed with code: %d", code)}
		}
	case "init":
		return &EngineError{Code: ErrNotInitialized, Message: fmt.Sprintf("engine initialization failed with code: %d", code)}
	default:
		return &EngineError{Code: ErrRender, Message: fmt.Sprintf("%s failed with code: %d", operation, code)}
	}
}
