package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// dependentModules are the in-repo Go modules that consume this SDK through a
// `replace github.com/hypen-space/core => <path to hypen-golang>` directive.
// Paths are relative to the hypen-golang directory.
//
// Each one has its own go.mod/go.sum, so bumping this module's `go` directive
// or a dependency (wazero, x/sys, ...) silently breaks them unless they are
// re-tidied too. The cross-SDK compatibility runner in particular is not run
// by any CI workflow, so this test is what keeps it building.
var dependentModules = []string{
	"../engine-compatibility-tests/runners/golang",
	"../examples/social/go",
	"examples/counter",
	"examples/router-app",
	"examples/todo-app",
}

// TestDependentModulesBuildAgainstSDK vets every dependent module in
// read-only module mode with the toolchain running this test. A dependent
// go.mod that lags this module (older `go` directive, stale require versions,
// missing go.sum entries) fails with "updates to go.mod needed" / "missing
// go.sum entry" instead of passing silently.
func TestDependentModulesBuildAgainstSDK(t *testing.T) {
	if testing.Short() {
		t.Skip("vets sibling modules with the go tool; skipped in -short mode")
	}
	goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
	if _, err := os.Stat(goBin); err != nil {
		t.Fatalf("go tool for the running toolchain not found at %s: %v", goBin, err)
	}
	required := os.Getenv("HYPEN_E2E_REQUIRE") == "1"

	for _, rel := range dependentModules {
		rel := rel
		t.Run(filepath.Base(filepath.Dir(rel))+"/"+filepath.Base(rel), func(t *testing.T) {
			dir, err := filepath.Abs(rel)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(dir, "go.mod")); err != nil {
				// Outside the monorepo (e.g. a standalone copy of the SDK)
				// the sibling modules do not exist.
				if required {
					t.Fatalf("dependent module %s missing: %v", rel, err)
				}
				t.Skipf("dependent module %s not present: %v", rel, err)
			}

			cmd := exec.Command(goBin, "vet", "-mod=readonly", "./...")
			cmd.Dir = dir
			cmd.Env = append(filterEnv(os.Environ(), "GOFLAGS=", "GOWORK=", "GOTOOLCHAIN="),
				"GOFLAGS=",
				"GOWORK=off",
				// Pin to the toolchain running this test so a `go` directive
				// mismatch is reported rather than papered over by a
				// toolchain switch.
				"GOTOOLCHAIN=local",
			)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("go vet -mod=readonly in %s failed (re-run `go mod tidy` there after changing hypen-golang/go.mod): %v\n%s",
					rel, err, out)
			}
		})
	}
}

func filterEnv(env []string, prefixes ...string) []string {
	out := make([]string, 0, len(env))
outer:
	for _, kv := range env {
		for _, p := range prefixes {
			if strings.HasPrefix(kv, p) {
				continue outer
			}
		}
		out = append(out, kv)
	}
	return out
}
