package buildinfo

import "testing"

func TestNewInfoSubstitutesPlaceholdersForUnstampedFields(t *testing.T) {
	tests := []struct {
		name        string
		rawVersion  string
		rawCommit   string
		rawDate     string
		wantVersion string
		wantCommit  string
		wantDate    string
	}{
		{
			name:        "fully stamped values pass through",
			rawVersion:  "v1.2.0",
			rawCommit:   "a1b2c3d4e5f6",
			rawDate:     "2026-08-02",
			wantVersion: "v1.2.0",
			wantCommit:  "a1b2c3d4e5f6",
			wantDate:    "2026-08-02",
		},
		{
			name:        "nothing stamped falls back to development placeholders",
			wantVersion: "dev",
			wantCommit:  "none",
			wantDate:    "unknown",
		},
		{
			name:        "whitespace-only values are treated as unstamped",
			rawVersion:  "  ",
			rawCommit:   "\t",
			rawDate:     "\n",
			wantVersion: "dev",
			wantCommit:  "none",
			wantDate:    "unknown",
		},
		{
			name:        "a single unstamped field does not disturb the others",
			rawVersion:  "v0.1.0",
			rawDate:     "2026-08-02",
			wantVersion: "v0.1.0",
			wantCommit:  "none",
			wantDate:    "2026-08-02",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := newInfo(tt.rawVersion, tt.rawCommit, tt.rawDate)
			if got.Version != tt.wantVersion {
				t.Errorf("Version = %q, want %q", got.Version, tt.wantVersion)
			}
			if got.Commit != tt.wantCommit {
				t.Errorf("Commit = %q, want %q", got.Commit, tt.wantCommit)
			}
			if got.Date != tt.wantDate {
				t.Errorf("Date = %q, want %q", got.Date, tt.wantDate)
			}
		})
	}
}

func TestShortCommitAbbreviatesOnlyLongCommits(t *testing.T) {
	tests := []struct {
		name   string
		commit string
		want   string
	}{
		{name: "long sha is abbreviated to git's default length", commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", want: "a1b2c3d"},
		{name: "sha exactly at the boundary is unchanged", commit: "a1b2c3d", want: "a1b2c3d"},
		{name: "placeholder is unchanged", commit: "none", want: "none"},
		{name: "empty commit is unchanged", commit: "", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := (Info{Commit: tt.commit}).ShortCommit(); got != tt.want {
				t.Errorf("ShortCommit() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestStringRendersVersionShortCommitAndDate(t *testing.T) {
	info := Info{Version: "v1.2.0", Commit: "a1b2c3d4e5f6", Date: "2026-08-02"}
	const want = "v1.2.0 (a1b2c3d, 2026-08-02)"
	if got := info.String(); got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}

// Get reads the package-level link-time variables. An unstamped test binary
// exercises the placeholder path, which is what a local `go build` produces.
func TestGetReturnsNormalizedLinkTimeValues(t *testing.T) {
	got := Get()
	want := newInfo(version, commit, date)
	if got != want {
		t.Errorf("Get() = %+v, want %+v", got, want)
	}
	if got.Version == "" || got.Commit == "" || got.Date == "" {
		t.Errorf("Get() returned an empty field: %+v", got)
	}
}
