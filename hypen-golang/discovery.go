package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DiscoveredComponent represents a component discovered from the filesystem
type DiscoveredComponent struct {
	Name       string
	HypenPath  string
	ModulePath string
	Template   string
	HasModule  bool
}

// DiscoveryPattern represents which naming patterns to look for
type DiscoveryPattern string

const (
	PatternFolder  DiscoveryPattern = "folder"
	PatternSibling DiscoveryPattern = "sibling"
	PatternIndex   DiscoveryPattern = "index"
)

// DiscoveryOptions configures the component discovery
type DiscoveryOptions struct {
	// Patterns specifies which naming patterns to look for
	// Default: [PatternFolder, PatternSibling, PatternIndex]
	Patterns []DiscoveryPattern

	// Recursive enables scanning subdirectories
	// Default: false
	Recursive bool

	// Debug enables debug logging
	Debug bool
}

// DefaultDiscoveryOptions returns sensible defaults
func DefaultDiscoveryOptions() DiscoveryOptions {
	return DiscoveryOptions{
		Patterns:  []DiscoveryPattern{PatternFolder, PatternSibling, PatternIndex},
		Recursive: false,
		Debug:     false,
	}
}

// WatchOptions extends DiscoveryOptions with watch-specific callbacks
type WatchOptions struct {
	DiscoveryOptions

	// OnChange is called when the component list changes
	OnChange func(components []DiscoveredComponent)

	// OnAdd is called when a component is added
	OnAdd func(component DiscoveredComponent)

	// OnRemove is called when a component is removed
	OnRemove func(name string)

	// OnUpdate is called when a component is updated
	OnUpdate func(component DiscoveredComponent)

	// PollInterval is the interval between filesystem polls (for watching)
	// Default: 1 second
	PollInterval time.Duration
}

// ComponentWatcher watches a directory for component changes
type ComponentWatcher struct {
	mu              sync.RWMutex
	baseDir         string
	options         WatchOptions
	current         map[string]DiscoveredComponent
	stopChan        chan struct{}
	running         bool
	debugLog        func(format string, args ...any)
}

// DiscoverComponents discovers all Hypen components in a directory
func DiscoverComponents(baseDir string, options *DiscoveryOptions) ([]DiscoveredComponent, error) {
	opts := DefaultDiscoveryOptions()
	if options != nil {
		if len(options.Patterns) > 0 {
			opts.Patterns = options.Patterns
		}
		opts.Recursive = options.Recursive
		opts.Debug = options.Debug
	}

	debugLog := func(format string, args ...any) {}
	if opts.Debug {
		debugLog = func(format string, args ...any) {
			LogDiscovery.Debug(format, args...)
		}
	}

	resolvedDir, err := filepath.Abs(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve directory: %w", err)
	}

	debugLog("Scanning directory: %s", resolvedDir)
	debugLog("Patterns: %v", opts.Patterns)

	components := []DiscoveredComponent{}
	seen := make(map[string]bool)

	// Helper to check if pattern is enabled
	hasPattern := func(p DiscoveryPattern) bool {
		for _, pattern := range opts.Patterns {
			if pattern == p {
				return true
			}
		}
		return false
	}

	// Helper to add a component if not already seen
	addComponent := func(name, hypenPath, modulePath string) {
		if seen[name] {
			debugLog("Skipping duplicate: %s", name)
			return
		}

		template, err := os.ReadFile(hypenPath)
		if err != nil {
			debugLog("Failed to read template %s: %v", hypenPath, err)
			return
		}

		// Preserve import statements in templates — the engine now processes them
		// via parse_document() and resolves imports through the SDK resolver
		cleanTemplate := strings.TrimSpace(string(template))

		seen[name] = true
		hasModule := modulePath != ""

		components = append(components, DiscoveredComponent{
			Name:       name,
			HypenPath:  hypenPath,
			ModulePath: modulePath,
			Template:   cleanTemplate,
			HasModule:  hasModule,
		})

		if hasModule {
			debugLog("Found: %s (with module)", name)
		} else {
			debugLog("Found: %s (stateless)", name)
		}
	}

	// Scan for folder-based components
	var scanForFolderComponents func(dir string) error
	scanForFolderComponents = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}

		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}

			folderPath := filepath.Join(dir, entry.Name())
			componentName := entry.Name()

			// Check folder-based pattern: Name/component.hypen
			if hasPattern(PatternFolder) {
				hypenPath := filepath.Join(folderPath, "component.hypen")
				if fileExists(hypenPath) {
					modulePath := filepath.Join(folderPath, "component.go")
					if !fileExists(modulePath) {
						modulePath = ""
					}
					addComponent(componentName, hypenPath, modulePath)
					continue
				}
			}

			// Check index-based pattern: Name/index.hypen
			if hasPattern(PatternIndex) {
				hypenPath := filepath.Join(folderPath, "index.hypen")
				if fileExists(hypenPath) {
					modulePath := filepath.Join(folderPath, "index.go")
					if !fileExists(modulePath) {
						modulePath = ""
					}
					addComponent(componentName, hypenPath, modulePath)
					continue
				}
			}

			// Recursive scan
			if opts.Recursive {
				if err := scanForFolderComponents(folderPath); err != nil {
					debugLog("Error scanning %s: %v", folderPath, err)
				}
			}
		}

		return nil
	}

	// Scan for sibling file components
	var scanForSiblingComponents func(dir string) error
	scanForSiblingComponents = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}

		for _, entry := range entries {
			if entry.IsDir() {
				if opts.Recursive {
					if err := scanForSiblingComponents(filepath.Join(dir, entry.Name())); err != nil {
						debugLog("Error scanning %s: %v", entry.Name(), err)
					}
				}
				continue
			}

			if !strings.HasSuffix(entry.Name(), ".hypen") {
				continue
			}

			hypenPath := filepath.Join(dir, entry.Name())
			baseName := strings.TrimSuffix(entry.Name(), ".hypen")

			// Skip component.hypen and index.hypen (handled by folder patterns)
			if baseName == "component" || baseName == "index" {
				continue
			}

			modulePath := filepath.Join(dir, baseName+".go")
			if !fileExists(modulePath) {
				modulePath = ""
			}

			addComponent(baseName, hypenPath, modulePath)
		}

		return nil
	}

	// Run scans based on patterns
	if hasPattern(PatternFolder) || hasPattern(PatternIndex) {
		if err := scanForFolderComponents(resolvedDir); err != nil {
			return nil, fmt.Errorf("folder scan failed: %w", err)
		}
	}

	if hasPattern(PatternSibling) {
		if err := scanForSiblingComponents(resolvedDir); err != nil {
			return nil, fmt.Errorf("sibling scan failed: %w", err)
		}
	}

	debugLog("Discovered %d components", len(components))

	return components, nil
}

// LoadDiscoveredComponents loads discovered components into a ComponentLoader
func LoadDiscoveredComponents(components []DiscoveredComponent, loader *ComponentLoader) {
	for _, component := range components {
		// Create a module definition (stateless if no module file)
		module := NewAppBuilder(nil, nil).Build()

		loader.Register(component.Name, module, component.Template, component.HypenPath)
	}
}

// WatchComponents watches a directory for component changes
func WatchComponents(baseDir string, options *WatchOptions) *ComponentWatcher {
	opts := WatchOptions{
		DiscoveryOptions: DefaultDiscoveryOptions(),
		PollInterval:     time.Second,
	}
	if options != nil {
		opts = *options
		if opts.PollInterval == 0 {
			opts.PollInterval = time.Second
		}
	}

	debugLog := func(format string, args ...any) {}
	if opts.Debug {
		debugLog = func(format string, args ...any) {
			LogDiscovery.Child("watch").Debug(format, args...)
		}
	}

	watcher := &ComponentWatcher{
		baseDir:  baseDir,
		options:  opts,
		current:  make(map[string]DiscoveredComponent),
		stopChan: make(chan struct{}),
		running:  false,
		debugLog: debugLog,
	}

	return watcher
}

// Start starts watching for changes
func (w *ComponentWatcher) Start() {
	w.mu.Lock()
	if w.running {
		w.mu.Unlock()
		return
	}
	w.running = true
	w.mu.Unlock()

	// Initial scan
	w.rescan()

	// Start polling
	go w.poll()
}

// Stop stops watching for changes
func (w *ComponentWatcher) Stop() {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.running {
		return
	}

	close(w.stopChan)
	w.running = false
}

// GetComponents returns the current list of discovered components
func (w *ComponentWatcher) GetComponents() []DiscoveredComponent {
	w.mu.RLock()
	defer w.mu.RUnlock()

	components := make([]DiscoveredComponent, 0, len(w.current))
	for _, c := range w.current {
		components = append(components, c)
	}
	return components
}

func (w *ComponentWatcher) poll() {
	ticker := time.NewTicker(w.options.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-w.stopChan:
			return
		case <-ticker.C:
			w.rescan()
		}
	}
}

func (w *ComponentWatcher) rescan() {
	w.debugLog("Rescanning...")

	newComponents, err := DiscoverComponents(w.baseDir, &w.options.DiscoveryOptions)
	if err != nil {
		w.debugLog("Error discovering components: %v", err)
		return
	}

	newMap := make(map[string]DiscoveredComponent)
	for _, c := range newComponents {
		newMap[c.Name] = c
	}

	w.mu.Lock()
	oldMap := w.current
	w.current = newMap
	w.mu.Unlock()

	// Find added/removed/updated
	for name, component := range newMap {
		existing, exists := oldMap[name]
		if !exists {
			w.debugLog("Added: %s", name)
			if w.options.OnAdd != nil {
				w.options.OnAdd(component)
			}
		} else if existing.Template != component.Template || existing.ModulePath != component.ModulePath {
			w.debugLog("Updated: %s", name)
			if w.options.OnUpdate != nil {
				w.options.OnUpdate(component)
			}
		}
	}

	for name := range oldMap {
		if _, exists := newMap[name]; !exists {
			w.debugLog("Removed: %s", name)
			if w.options.OnRemove != nil {
				w.options.OnRemove(name)
			}
		}
	}

	if w.options.OnChange != nil {
		w.options.OnChange(newComponents)
	}
}

// GenerateComponentsCode generates Go code for discovered components
func GenerateComponentsCode(baseDir string, packageName string, options *DiscoveryOptions) (string, error) {
	components, err := DiscoverComponents(baseDir, options)
	if err != nil {
		return "", err
	}

	var sb strings.Builder

	sb.WriteString(fmt.Sprintf(`// Code generated by Hypen component discovery. DO NOT EDIT.
package %s

import (
	core "github.com/hypen-space/core"
)

`, packageName))

	// Generate component variables
	for _, component := range components {
		templateLiteral := fmt.Sprintf("`%s`", strings.ReplaceAll(component.Template, "`", "` + \"`\" + `"))

		sb.WriteString(fmt.Sprintf(`// %s component
var %s = &core.ComponentDefinition{
	Name:     "%s",
	Template: %s,
	Module:   core.NewAppBuilder(nil, nil).Build(),
}

`, component.Name, component.Name, component.Name, templateLiteral))
	}

	// Generate init function to register all components
	sb.WriteString(`// RegisterComponents registers all discovered components with the given loader
func RegisterComponents(loader *core.ComponentLoader) {
`)
	for _, component := range components {
		sb.WriteString(fmt.Sprintf("\tloader.Register(%s)\n", component.Name))
	}
	sb.WriteString("}\n")

	return sb.String(), nil
}

// fileExists checks if a file exists
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
