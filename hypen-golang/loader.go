package core

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var logLoader = LogLoader

// ComponentDefinition defines a Hypen component
type ComponentDefinition struct {
	Name     string
	Module   *ModuleDefinition
	Template string
	Path     string
}

// ComponentLoader loads and registers Hypen components
type ComponentLoader struct {
	mu         sync.RWMutex
	components map[string]*ComponentDefinition
}

// NewComponentLoader creates a new ComponentLoader
func NewComponentLoader() *ComponentLoader {
	return &ComponentLoader{
		components: make(map[string]*ComponentDefinition),
	}
}

// Register registers a component with its module and template
func (l *ComponentLoader) Register(name string, module *ModuleDefinition, template string, path string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if path == "" {
		path = name
	}

	l.components[name] = &ComponentDefinition{
		Name:     name,
		Module:   module,
		Template: template,
		Path:     path,
	}
}

// Get returns a registered component by name
func (l *ComponentLoader) Get(name string) *ComponentDefinition {
	l.mu.RLock()
	defer l.mu.RUnlock()

	return l.components[name]
}

// Has checks if a component is registered
func (l *ComponentLoader) Has(name string) bool {
	l.mu.RLock()
	defer l.mu.RUnlock()

	_, exists := l.components[name]
	return exists
}

// GetNames returns all registered component names
func (l *ComponentLoader) GetNames() []string {
	l.mu.RLock()
	defer l.mu.RUnlock()

	names := make([]string, 0, len(l.components))
	for name := range l.components {
		names = append(names, name)
	}
	return names
}

// GetAll returns all registered components
func (l *ComponentLoader) GetAll() []*ComponentDefinition {
	l.mu.RLock()
	defer l.mu.RUnlock()

	components := make([]*ComponentDefinition, 0, len(l.components))
	for _, comp := range l.components {
		components = append(components, comp)
	}
	return components
}

// Clear removes all registered components
func (l *ComponentLoader) Clear() {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.components = make(map[string]*ComponentDefinition)
}

// LoadFromDirectory loads a component from a directory
// Expects: component.go and component.hypen in the same directory
func (l *ComponentLoader) LoadFromDirectory(name string, dirPath string) error {
	// Check if directory exists
	info, err := os.Stat(dirPath)
	if err != nil {
		return fmt.Errorf("directory not found: %s: %w", dirPath, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("not a directory: %s", dirPath)
	}

	// Read template file
	templatePath := filepath.Join(dirPath, "component.hypen")
	templateBytes, err := os.ReadFile(templatePath)
	if err != nil {
		return fmt.Errorf("failed to read template: %w", err)
	}

	// Note: In Go, we can't dynamically load module definitions like TypeScript
	// The module must be registered programmatically
	// For now, we just register with the template and a nil module
	l.Register(name, nil, string(templateBytes), dirPath)

	logLoader.Debug("Loaded component: %s from %s", name, dirPath)
	return nil
}

// LoadFromComponentsDir auto-loads all components from a directory
// Scans for subdirectories containing component.hypen
func (l *ComponentLoader) LoadFromComponentsDir(baseDir string) error {
	// Check if directory exists
	info, err := os.Stat(baseDir)
	if err != nil {
		if os.IsNotExist(err) {
			logLoader.Warn("Components directory not found: %s", baseDir)
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("not a directory: %s", baseDir)
	}

	entries, err := os.ReadDir(baseDir)
	if err != nil {
		return fmt.Errorf("failed to read directory: %w", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		componentDir := filepath.Join(baseDir, entry.Name())
		hypenPath := filepath.Join(componentDir, "component.hypen")

		// Only load if component.hypen exists
		if _, err := os.Stat(hypenPath); err == nil {
			if err := l.LoadFromDirectory(entry.Name(), componentDir); err != nil {
				logLoader.Error("Failed to load component %s: %v", entry.Name(), err)
			}
		}
	}

	logLoader.Debug("Loaded %d components from %s", len(l.components), baseDir)
	return nil
}

// RegisterWithModule registers a component with a pre-built module definition
func (l *ComponentLoader) RegisterWithModule(name string, module *ModuleDefinition, template string) {
	l.Register(name, module, template, name)
}

// Global component loader instance
var ComponentLoaderInstance = NewComponentLoader()
