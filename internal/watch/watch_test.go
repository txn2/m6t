package watch

import "testing"

func TestDirOf(t *testing.T) {
	tests := map[string]string{
		"a.yaml":                ".",
		"manifests/deploy.yaml": "manifests",
		"a/b/c.yaml":            "a/b",
		".":                     ".",
	}
	for name, want := range tests {
		if got := dirOf(name); got != want {
			t.Errorf("dirOf(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestRelFromOSReportsAnErrorWhenThePathsCannotBeRelativized(t *testing.T) {
	// filepath.Rel refuses to relate an absolute path against a relative
	// root — the one way this ever fails in practice, since fsWatcher always
	// hands it two absolute paths.
	if _, err := relFromOS("relative/root", "/absolute/path"); err == nil {
		t.Error("relFromOS with an unrelatable pair succeeded, want an error")
	}
}
