package git

import (
	"strings"
	"testing"
)

// records builds a -z payload: every record NUL-terminated, including the
// last, which is what git actually writes and what splitRecords has to shed.
func records(items ...string) string {
	var b strings.Builder
	for _, item := range items {
		b.WriteString(item)
		b.WriteString(recordSeparator)
	}
	return b.String()
}

// The fixture records below are real `git status --porcelain=v2 --branch -z`
// output, captured from repositories built for each case rather than written
// from the manual page: a parser tested against its author's memory of a
// format is tested against the same misunderstanding twice.
const (
	fixtureModified  = "1 .M N... 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 5626abf0f72e58d7a153368ba57db4c673c0e171 a/b/one.yaml"
	fixtureDeleted   = "1 .D N... 100644 100644 000000 abaddc0b9edd523c69166a2c9f3a9e31a4c873e3 abaddc0b9edd523c69166a2c9f3a9e31a4c873e3 gone.txt"
	fixtureStagedAdd = "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 5626abf0f72e58d7a153368ba57db4c673c0e171 fresh.yaml"
	fixtureRenamed   = "2 R. N... 100644 100644 100644 9d80ddb4cc7365318accecc8f8084993ecf72e69 9d80ddb4cc7365318accecc8f8084993ecf72e69 R100 new.txt"
	fixtureSubmodule = "1 A. S... 000000 160000 160000 0000000000000000000000000000000000000000 5d48ba27cb4a2ace9866e77c972d9d1f6650fcc2 sub"
	fixtureUnmerged  = "u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 ba2906d0666cf726c7eaadd2cd3db615dedfdf3a e45c9c2666d44e0327c1f9c239a74c508336053e c.txt"
	fixtureUntracked = "? u.txt"
)

func TestParseReadsEveryEntryKind(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want FileStatus
	}{
		{
			name: "worktree modification",
			raw:  fixtureModified,
			want: FileStatus{Path: "a/b/one.yaml", Worktree: StateModified},
		},
		{
			name: "worktree deletion",
			raw:  fixtureDeleted,
			want: FileStatus{Path: "gone.txt", Worktree: StateDeleted},
		},
		{
			name: "staged addition",
			raw:  fixtureStagedAdd,
			want: FileStatus{Path: "fresh.yaml", Staged: StateAdded},
		},
		{
			name: "a submodule is an ordinary entry with an S sub-field",
			raw:  fixtureSubmodule,
			want: FileStatus{Path: "sub", Staged: StateAdded},
		},
		{
			name: "untracked",
			raw:  fixtureUntracked,
			want: FileStatus{Path: "u.txt", Worktree: StateUntracked},
		},
		{
			name: "unmerged carries no staged/worktree split",
			raw:  fixtureUnmerged,
			want: FileStatus{Path: "c.txt", Conflicted: true},
		},
		{
			name: "staged and re-edited is one entry on both sides",
			raw:  "1 MM N... 100644 100644 100644 5626abf 5626abf both.yaml",
			want: FileStatus{Path: "both.yaml", Staged: StateModified, Worktree: StateModified},
		},
		{
			name: "a typechange reads as a modification",
			raw:  "1 .T N... 100644 100644 120000 5626abf 5626abf link.yaml",
			want: FileStatus{Path: "link.yaml", Worktree: StateModified},
		},
		{
			name: "a path containing spaces survives the field split",
			raw:  "1 .M N... 100644 100644 100644 5626abf 5626abf dir with spaces/a b.yaml",
			want: FileStatus{Path: "dir with spaces/a b.yaml", Worktree: StateModified},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status := parse(records(tt.raw))
			if len(status.Files) != 1 {
				t.Fatalf("parsed %d files, want 1: %+v", len(status.Files), status.Files)
			}
			if status.Files[0] != tt.want {
				t.Errorf("file = %+v, want %+v", status.Files[0], tt.want)
			}
		})
	}
}

// A rename record spends two NUL-terminated fields where every other kind
// spends one. A parser that missed that would read the source path as the
// next record and lose an entry every time — this pins both halves.
func TestParseReadsRenameSourceFromTheFollowingField(t *testing.T) {
	status := parse(records(fixtureRenamed, "old.txt", fixtureUntracked))

	want := []FileStatus{
		{Path: "new.txt", Staged: StateRenamed, OrigPath: "old.txt"},
		{Path: "u.txt", Worktree: StateUntracked},
	}
	if len(status.Files) != len(want) {
		t.Fatalf("parsed %d files, want %d: %+v", len(status.Files), len(want), status.Files)
	}
	for i, got := range status.Files {
		if got != want[i] {
			t.Errorf("file[%d] = %+v, want %+v", i, got, want[i])
		}
	}
}

func TestParseReadsACopyRecord(t *testing.T) {
	copied := "2 C. N... 100644 100644 100644 9d80ddb 9d80ddb C100 copy.yaml"
	status := parse(records(copied, "source.yaml"))

	want := FileStatus{Path: "copy.yaml", Staged: StateCopied, OrigPath: "source.yaml"}
	if len(status.Files) != 1 {
		t.Fatalf("parsed %d files, want 1: %+v", len(status.Files), status.Files)
	}
	if status.Files[0] != want {
		t.Errorf("file = %+v, want %+v", status.Files[0], want)
	}
}

// A rename record at the very end of a truncated stream must not read past
// it. The entry keeps its own path and loses only the source.
func TestParseToleratesARenameWithNoFollowingField(t *testing.T) {
	status := parse(records(fixtureRenamed))

	if len(status.Files) != 1 {
		t.Fatalf("parsed %d files, want 1: %+v", len(status.Files), status.Files)
	}
	if got := status.Files[0].OrigPath; got != "" {
		t.Errorf("origPath = %q, want empty", got)
	}
	if got := status.Files[0].Path; got != "new.txt" {
		t.Errorf("path = %q, want new.txt", got)
	}
}

func TestParseReadsBranchHeaders(t *testing.T) {
	tests := []struct {
		name    string
		headers []string
		want    Branch
	}{
		{
			name:    "a branch with an upstream and both counts",
			headers: []string{"# branch.oid 07adf41", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +1 -0"},
			want:    Branch{Name: "main", Upstream: "origin/main", Ahead: 1},
		},
		{
			name:    "behind as well as ahead",
			headers: []string{"# branch.head topic", "# branch.upstream origin/topic", "# branch.ab +2 -3"},
			want:    Branch{Name: "topic", Upstream: "origin/topic", Ahead: 2, Behind: 3},
		},
		{
			name:    "a branch with no upstream reports no counts",
			headers: []string{"# branch.oid 83fab43", "# branch.head main"},
			want:    Branch{Name: "main"},
		},
		{
			name:    "detached HEAD has no branch name",
			headers: []string{"# branch.oid 83fab43", "# branch.head (detached)"},
			want:    Branch{Detached: true},
		},
		{
			name:    "a repository with no commits is unborn but still names its branch",
			headers: []string{"# branch.oid (initial)", "# branch.head main"},
			want:    Branch{Name: "main", Unborn: true},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parse(records(tt.headers...)).Branch
			if got != tt.want {
				t.Errorf("branch = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// Every malformed shape here is a record the parser must survive without
// inventing an entry: a status that dropped every badge because one line was
// unfamiliar would be worse than one badge missing.
func TestParseSkipsRecordsItCannotRead(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{name: "a record with no space at all", raw: "1"},
		{name: "an ordinary record missing its path", raw: "1 .M N... 100644 100644 100644 5626abf 5626abf"},
		{name: "a rename record missing its path", raw: "2 R. N... 100644 100644 100644 9d80ddb 9d80ddb R100"},
		{name: "an unmerged record missing its path", raw: "u UU N... 100644 100644 100644 100644 df967b9 ba2906d"},
		{name: "an unknown record kind", raw: "! ignored.txt"},
		{name: "a truncated XY pair", raw: "1 . N... 100644 100644 100644 5626abf 5626abf short.yaml"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status := parse(records(tt.raw))
			if len(status.Files) != 0 {
				t.Errorf("parsed %d files, want none: %+v", len(status.Files), status.Files)
			}
		})
	}
}

// git emits a record only for a path that differs, so a code this version
// does not recognize still means "this path changed". Reporting it as a
// modification keeps the badge; reporting it as nothing would make a file
// silently lose its badge the first time git grows a status code.
func TestParseTreatsAnUnrecognizedCodeAsAModification(t *testing.T) {
	status := parse(records("1 XY N... 100644 100644 100644 5626abf 5626abf odd.yaml"))

	if len(status.Files) != 1 {
		t.Fatalf("parsed %d files, want 1: %+v", len(status.Files), status.Files)
	}
	want := FileStatus{Path: "odd.yaml", Staged: StateModified, Worktree: StateModified}
	if status.Files[0] != want {
		t.Errorf("file = %+v, want %+v", status.Files[0], want)
	}
}

func TestParseReadsACleanRepository(t *testing.T) {
	status := parse(records("# branch.oid 83fab43", "# branch.head main"))

	if status.Availability != Available {
		t.Errorf("availability = %q, want %q", status.Availability, Available)
	}
	if status.Files == nil {
		t.Error("files is nil; it crosses the bridge as JSON and must marshal to []")
	}
	if len(status.Files) != 0 {
		t.Errorf("files = %+v, want none", status.Files)
	}
}

func TestParseReadsEmptyOutput(t *testing.T) {
	status := parse("")

	if status.Availability != Available {
		t.Errorf("availability = %q, want %q", status.Availability, Available)
	}
	if len(status.Files) != 0 {
		t.Errorf("files = %+v, want none", status.Files)
	}
}

// A whole-repository fixture: one status carrying every entry kind at once,
// in git's own order, which is what the UI actually receives.
func TestParseReadsAMixedWorkingTree(t *testing.T) {
	status := parse(records(
		"# branch.oid e591e1d",
		"# branch.head main",
		fixtureModified,
		fixtureDeleted,
		fixtureRenamed, "old.txt",
		fixtureSubmodule,
		fixtureUntracked,
	))

	if status.Branch.Name != "main" {
		t.Errorf("branch = %q, want main", status.Branch.Name)
	}
	wantPaths := []string{"a/b/one.yaml", "gone.txt", "new.txt", "sub", "u.txt"}
	if len(status.Files) != len(wantPaths) {
		t.Fatalf("parsed %d files, want %d: %+v", len(status.Files), len(wantPaths), status.Files)
	}
	for i, want := range wantPaths {
		if status.Files[i].Path != want {
			t.Errorf("file[%d].path = %q, want %q", i, status.Files[i].Path, want)
		}
	}
}

func TestAheadBehindRejectsMalformedCounts(t *testing.T) {
	tests := []struct {
		name       string
		value      string
		wantAhead  int
		wantBehind int
	}{
		{name: "well formed", value: "+4 -7", wantAhead: 4, wantBehind: 7},
		{name: "zero", value: "+0 -0"},
		{name: "no separator", value: "+4"},
		{name: "signs swapped", value: "-4 +7"},
		{name: "missing signs", value: "4 7"},
		{name: "not numbers", value: "+x -y"},
		{name: "empty", value: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ahead, behind := aheadBehind(tt.value)
			if ahead != tt.wantAhead || behind != tt.wantBehind {
				t.Errorf("aheadBehind(%q) = %d, %d; want %d, %d",
					tt.value, ahead, behind, tt.wantAhead, tt.wantBehind)
			}
		})
	}
}

// A header with a key but no value must not panic or half-apply.
func TestApplyHeaderIgnoresAValuelessRecord(t *testing.T) {
	status := parse(records("# branch.head", "# branch.oid 83fab43"))

	if status.Branch.Name != "" {
		t.Errorf("branch name = %q, want empty", status.Branch.Name)
	}
	if status.Branch.Unborn {
		t.Error("unborn = true, want false")
	}
}

func TestSplitRecordsDropsOnlyTheTerminatingEmptyField(t *testing.T) {
	got := splitRecords("a\x00b\x00")
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("splitRecords = %q, want [a b]", got)
	}

	// Output that does not end in a separator keeps its last field.
	if got := splitRecords("a\x00b"); len(got) != 2 || got[1] != "b" {
		t.Errorf("splitRecords without a trailing NUL = %q, want [a b]", got)
	}

	if got := splitRecords(""); len(got) != 0 {
		t.Errorf("splitRecords(\"\") = %q, want none", got)
	}
}
