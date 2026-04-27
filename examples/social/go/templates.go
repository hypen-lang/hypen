package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func loadTemplate(name string) string {
	componentsDir := filepath.Join("..", "components")
	data, err := os.ReadFile(filepath.Join(componentsDir, name, "component.hypen"))
	if err != nil {
		panic(fmt.Sprintf("failed to load component %s: %v", name, err))
	}
	return string(data)
}
