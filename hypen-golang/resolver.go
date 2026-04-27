package core

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// ImportClauseType represents the type of import clause
type ImportClauseType string

const (
	ImportClauseNamed   ImportClauseType = "named"
	ImportClauseDefault ImportClauseType = "default"
)

// ImportClause represents what is being imported
type ImportClause struct {
	Type  ImportClauseType
	Names []string // For named imports
	Name  string   // For default imports
}

// ImportSourceType represents where the import comes from
type ImportSourceType string

const (
	ImportSourceLocal ImportSourceType = "local"
	ImportSourceURL   ImportSourceType = "url"
)

// ImportSource represents the source of an import
type ImportSource struct {
	Type ImportSourceType
	Path string // For local imports
	URL  string // For URL imports
}

// ImportStatement represents a parsed import statement
type ImportStatement struct {
	Clause ImportClause
	Source ImportSource
}

// ResolvedComponent represents a resolved component with module and template
type ResolvedComponent struct {
	Module   *ModuleDefinition
	Template string
}

// ResolverOptions configures the ComponentResolver
type ResolverOptions struct {
	// BaseDir is the base directory for resolving relative local paths
	BaseDir string

	// Cache enables caching of resolved components
	Cache bool

	// CustomFetch is a custom function for fetching URL imports
	CustomFetch func(url string) (string, error)

	// App provides the component registry for looking up pre-registered modules.
	// When set, the resolver checks the registry before doing file I/O.
	App *HypenApp
}

// DefaultResolverOptions returns sensible defaults
func DefaultResolverOptions() ResolverOptions {
	return ResolverOptions{
		BaseDir: ".",
		Cache:   true,
	}
}

// ComponentResolver resolves and loads components from local files or remote URLs
type ComponentResolver struct {
	mu      sync.RWMutex
	cache   map[string]*ResolvedComponent
	options ResolverOptions
	app     *HypenApp
}

// NewComponentResolver creates a new ComponentResolver
func NewComponentResolver(options *ResolverOptions) *ComponentResolver {
	opts := DefaultResolverOptions()
	if options != nil {
		if options.BaseDir != "" {
			opts.BaseDir = options.BaseDir
		}
		opts.Cache = options.Cache
		if options.CustomFetch != nil {
			opts.CustomFetch = options.CustomFetch
		}
	}

	var appRef *HypenApp
	if options != nil {
		appRef = options.App
	}

	return &ComponentResolver{
		cache:   make(map[string]*ResolvedComponent),
		options: opts,
		app:     appRef,
	}
}

// Resolve resolves a component from an import statement.
// Checks the app registry first (if available), then falls back to file I/O.
func (r *ComponentResolver) Resolve(stmt ImportStatement) (map[string]*ResolvedComponent, error) {
	// Check app registry first — if a component is pre-registered,
	// use its template directly (it will be mounted as a full module)
	if r.app != nil {
		names := r.getImportNames(stmt.Clause)
		allFound := true
		for _, name := range names {
			if !r.app.Has(name) {
				allFound = false
				break
			}
		}
		if allFound {
			result := make(map[string]*ResolvedComponent)
			for _, name := range names {
				def := r.app.Get(name)
				result[name] = &ResolvedComponent{
					Module:   def,
					Template: def.Template, // Use the module's inline template
				}
			}
			return result, nil
		}
	}

	sourcePath := r.getSourcePath(stmt.Source)

	// Check cache first
	if r.options.Cache {
		r.mu.RLock()
		if cached, ok := r.cache[sourcePath]; ok {
			r.mu.RUnlock()
			return r.extractComponents(stmt.Clause, cached), nil
		}
		r.mu.RUnlock()
	}

	// Load the component
	var component *ResolvedComponent
	var err error

	if stmt.Source.Type == ImportSourceLocal {
		component, err = r.resolveLocal(stmt.Source.Path)
	} else {
		component, err = r.resolveURL(stmt.Source.URL)
	}

	if err != nil {
		return nil, err
	}

	// Cache it
	if r.options.Cache {
		r.mu.Lock()
		r.cache[sourcePath] = component
		r.mu.Unlock()
	}

	return r.extractComponents(stmt.Clause, component), nil
}

// resolveLocal resolves a component from a local file path
func (r *ComponentResolver) resolveLocal(path string) (*ResolvedComponent, error) {
	fullPath := filepath.Join(r.options.BaseDir, path)

	// Try .hypen extension
	hypenPath := fullPath
	if !strings.HasSuffix(hypenPath, ".hypen") {
		hypenPath = fullPath + ".hypen"
	}

	template, err := os.ReadFile(hypenPath)
	if err != nil {
		// Try without extension (maybe it already has one or is a directory)
		template, err = os.ReadFile(fullPath)
		if err != nil {
			return nil, fmt.Errorf("component not found at %s: %w", hypenPath, err)
		}
	}

	// Stateless component — no Go module needed
	moduleDef := NewAppBuilder(nil, nil).Build()

	return &ResolvedComponent{
		Module:   moduleDef,
		Template: string(template),
	}, nil
}

// resolveURL resolves a component from a URL
func (r *ComponentResolver) resolveURL(url string) (*ResolvedComponent, error) {
	var body string
	var err error

	if r.options.CustomFetch != nil {
		body, err = r.options.CustomFetch(url)
	} else {
		body, err = r.defaultFetch(url)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to fetch component from %s: %w", url, err)
	}

	// Parse the response as JSON
	var data struct {
		Module   map[string]any `json:"module"`
		Template string         `json:"template"`
	}

	if err := json.Unmarshal([]byte(body), &data); err != nil {
		return nil, fmt.Errorf("failed to parse component from %s: %w", url, err)
	}

	if data.Template == "" {
		return nil, fmt.Errorf("invalid component format from %s: missing template", url)
	}

	// Create a simple module definition from the module data
	var moduleDef *ModuleDefinition
	if data.Module != nil {
		// Extract state from module data if available
		initialState := make(map[string]any)
		if state, ok := data.Module["state"].(map[string]any); ok {
			initialState = state
		}
		moduleDef = NewAppBuilder(initialState, nil).Build()
	} else {
		// Stateless component
		moduleDef = NewAppBuilder(nil, nil).Build()
	}

	return &ResolvedComponent{
		Module:   moduleDef,
		Template: data.Template,
	}, nil
}

// defaultFetch performs a standard HTTP GET request
func (r *ComponentResolver) defaultFetch(url string) (string, error) {
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	return string(body), nil
}

// getImportNames returns all component names from an import clause
func (r *ComponentResolver) getImportNames(clause ImportClause) []string {
	if clause.Type == ImportClauseDefault {
		return []string{clause.Name}
	}
	return clause.Names
}

// extractComponents extracts the requested components based on the import clause
func (r *ComponentResolver) extractComponents(clause ImportClause, component *ResolvedComponent) map[string]*ResolvedComponent {
	result := make(map[string]*ResolvedComponent)

	if clause.Type == ImportClauseDefault {
		result[clause.Name] = component
	} else {
		// Named imports - for now, we only support single exports
		for _, name := range clause.Names {
			result[name] = component
		}
	}

	return result
}

// getSourcePath returns the source path as a string (for caching)
func (r *ComponentResolver) getSourcePath(source ImportSource) string {
	if source.Type == ImportSourceLocal {
		return source.Path
	}
	return source.URL
}

// ClearCache clears the component cache
func (r *ComponentResolver) ClearCache() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cache = make(map[string]*ResolvedComponent)
}

// GetCacheSize returns the number of cached components
func (r *ComponentResolver) GetCacheSize() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.cache)
}

// ParseImports parses import statements from Hypen DSL text
func ParseImports(text string) []ImportStatement {
	imports := []ImportStatement{}

	// Regex to match: import { A, B } from "source" or import Name from "source"
	importRegex := regexp.MustCompile(`import\s+(?:(\{[^}]*\})|(\w+))\s+from\s+["']([^"']+)["']`)

	matches := importRegex.FindAllStringSubmatch(text, -1)

	for _, match := range matches {
		if len(match) < 4 {
			continue
		}

		namedImports := match[1]
		defaultImport := match[2]
		source := match[3]

		if source == "" {
			continue
		}

		var clause ImportClause

		if namedImports != "" {
			// Named imports: { Button, Card }
			// Remove { and }
			inner := strings.Trim(namedImports, "{}")
			names := []string{}
			for _, name := range strings.Split(inner, ",") {
				name = strings.TrimSpace(name)
				if name != "" {
					names = append(names, name)
				}
			}
			clause = ImportClause{
				Type:  ImportClauseNamed,
				Names: names,
			}
		} else if defaultImport != "" {
			// Default import: HomePage
			clause = ImportClause{
				Type: ImportClauseDefault,
				Name: defaultImport,
			}
		} else {
			continue
		}

		// Determine if source is URL or local path
		var importSource ImportSource
		if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
			importSource = ImportSource{
				Type: ImportSourceURL,
				URL:  source,
			}
		} else {
			importSource = ImportSource{
				Type: ImportSourceLocal,
				Path: source,
			}
		}

		imports = append(imports, ImportStatement{
			Clause: clause,
			Source: importSource,
		})
	}

	return imports
}

// RemoveImports removes import statements from Hypen DSL text
func RemoveImports(text string) string {
	importRegex := regexp.MustCompile(`import\s+(?:\{[^}]+\}|\w+)\s+from\s+["'][^"']+["']\s*`)
	return importRegex.ReplaceAllString(text, "")
}
