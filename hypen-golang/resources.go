package core

import (
	"encoding/json"
	"fmt"
	"os"
)

// ResourceMap is a flat mapping of resource name to raw SVG string.
// Resources are passed to the engine unparsed; the Rust engine handles
// SVG parsing centrally via the hypen_register_resources WASI export.
type ResourceMap = map[string]string

// LoadResourcesFile loads a JSON file containing a flat name→SVG map
// and returns it as a ResourceMap.
func LoadResourcesFile(path string) (ResourceMap, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read resources file: %w", err)
	}
	var resources ResourceMap
	if err := json.Unmarshal(data, &resources); err != nil {
		return nil, fmt.Errorf("failed to parse resources file: %w", err)
	}
	return resources, nil
}
