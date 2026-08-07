package git

import (
	"errors"
	"strconv"
	"strings"
	"testing"
)

// The fixture tests here drive the real git binary, for the reason
// run_test.go states: what is under test is whether the argv this package
// builds is one git accepts and answers. A stub would agree with a wrong flag.
// The parser tests below them use captured output, because the shapes they
// cover — a truncated record, a SHA-256 zero SHA — are ones a fixture cannot
// be made to produce on demand.

// blameOf reads the blame these tests assert against, failing the test rather
// than returning an error nobody would check.
func blameOf(t *testing.T, dir, path string) Blame {
	t.Helper()
	blame, err := LoadBlame(dir, path)
	if err != nil {
		t.Fatalf("LoadBlame(%q): %v", path, err)
	}
	return blame
}

// commitAt is the commit a line is attributed to, by 1-based line number.
func commitAt(t *testing.T, blame Blame, line int) BlameCommit {
	t.Helper()
	if line < 1 || line > len(blame.Lines) {
		t.Fatalf("line %d is outside the blame's %d lines", line, len(blame.Lines))
	}
	index := blame.Lines[line-1]
	if index < 0 || index >= len(blame.Commits) {
		t.Fatalf("line %d has commit index %d, outside the %d commits", line, index, len(blame.Commits))
	}
	return blame.Commits[index]
}

// The acceptance criterion: each line goes to the author of the commit that
// last touched it, not to the author of the file.
func TestLoadBlameAttributesLinesToTheAuthorWhoLastTouchedThem(t *testing.T) {
	dir := initRepo(t)
	writeFixtureFile(t, dir, "a.yaml", "first\nsecond\nthird\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "one")

	writeFixtureFile(t, dir, "a.yaml", "first\nchanged\nthird\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir,
		"-c", "user.name=Second Author", "-c", "user.email=second@example.invalid",
		"commit", "-qm", "two")

	blame := blameOf(t, dir, "a.yaml")

	if len(blame.Lines) != 3 {
		t.Fatalf("lines = %d, want 3", len(blame.Lines))
	}
	if got := commitAt(t, blame, 1).Author; got != "m6t tests" {
		t.Errorf("line 1 author = %q, want the first commit's", got)
	}
	if got := commitAt(t, blame, 2).Author; got != "Second Author" {
		t.Errorf("line 2 author = %q, want the second commit's", got)
	}
	if got := commitAt(t, blame, 3).Author; got != "m6t tests" {
		t.Errorf("line 3 author = %q, want the first commit's", got)
	}
	if got := commitAt(t, blame, 2).Summary; got != "two" {
		t.Errorf("line 2 summary = %q, want %q", got, "two")
	}
	if commitAt(t, blame, 2).AuthorTime <= 0 {
		t.Error("line 2 has no author time")
	}
}

// A line edited on disk but not committed belongs to nobody. Attributing it to
// whoever wrote the line it replaced is the failure this guards: it would name
// a person for text they never wrote.
func TestLoadBlameMarksUncommittedLines(t *testing.T) {
	dir := commitFixture(t)
	writeFixtureFile(t, dir, "a.yaml", "one\nadded here\n")

	blame := blameOf(t, dir, "a.yaml")

	if got := commitAt(t, blame, 1); got.Uncommitted {
		t.Errorf("line 1 = %+v, want the committed line attributed", got)
	}
	second := commitAt(t, blame, 2)
	if !second.Uncommitted {
		t.Errorf("line 2 = %+v, want it marked uncommitted", second)
	}
	if strings.Trim(second.SHA, "0") != "" {
		t.Errorf("uncommitted SHA = %q, want git's all-zero name", second.SHA)
	}
}

// The wire form's whole point: one commit record however many lines it wrote.
func TestLoadBlameStatesEachCommitOnce(t *testing.T) {
	dir := initRepo(t)
	writeFixtureFile(t, dir, "a.yaml", strings.Repeat("line\n", 50))
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "one")

	blame := blameOf(t, dir, "a.yaml")

	if len(blame.Lines) != 50 {
		t.Fatalf("lines = %d, want 50", len(blame.Lines))
	}
	if len(blame.Commits) != 1 {
		t.Errorf("commits = %d, want 1 for a file from one commit", len(blame.Commits))
	}
}

// A path git will not blame has to say why. An empty blame would render as a
// blank column, which is also what a file with no history looks like.
func TestLoadBlameReportsGitsRefusal(t *testing.T) {
	dir := commitFixture(t)
	writeFixtureFile(t, dir, "untracked.yaml", "one\n")

	_, err := LoadBlame(dir, "untracked.yaml")
	if err == nil {
		t.Fatal("LoadBlame on an untracked path succeeded; want git's refusal")
	}
	if !strings.Contains(err.Error(), "untracked.yaml") {
		t.Errorf("error = %v, want git's own message about the path", err)
	}
}

// An empty file has no lines to attribute, and the slices still have to be
// slices: they cross the bridge as JSON, where nil is null.
func TestLoadBlameOnAnEmptyFileIsEmptyRatherThanNil(t *testing.T) {
	dir := initRepo(t)
	writeFixtureFile(t, dir, "empty.yaml", "")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "one")

	blame := blameOf(t, dir, "empty.yaml")

	if blame.Lines == nil || blame.Commits == nil {
		t.Fatalf("blame = %+v; nil marshals to null rather than []", blame)
	}
	if len(blame.Lines) != 0 {
		t.Errorf("lines = %d, want none", len(blame.Lines))
	}
}

func TestLoadBlameRejectsPathsOutsideTheProject(t *testing.T) {
	dir := commitFixture(t)

	for _, path := range []string{
		"",
		"../escape.yaml",
		"nested/../../escape.yaml",
		"..\\escape.yaml",
		"/etc/passwd",
		"a\x00.yaml",
	} {
		if _, err := LoadBlame(dir, path); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("LoadBlame(%q) = %v, want ErrInvalidPath", path, err)
		}
	}
}

// A leading dash is a file name, not an option: LoadBlame puts `--` in front
// of the path. Rejecting it would refuse a file git is perfectly able to blame.
func TestLoadBlameBlamesAFileNamedLikeAnOption(t *testing.T) {
	dir := initRepo(t)
	writeFixtureFile(t, dir, "-f.yaml", "one\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "one")

	blame := blameOf(t, dir, "-f.yaml")

	if len(blame.Lines) != 1 {
		t.Fatalf("lines = %d, want 1", len(blame.Lines))
	}
	if commitAt(t, blame, 1).Summary != "one" {
		t.Errorf("summary = %q, want %q", commitAt(t, blame, 1).Summary, "one")
	}
}

// A subdirectory path arrives slash-separated from the tree and has to survive
// the separator check that rejects an escape.
func TestLoadBlameBlamesAPathInASubdirectory(t *testing.T) {
	dir := initRepo(t)
	writeFixtureFile(t, dir, "deploy/base/svc.yaml", "kind: Service\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "one")

	blame := blameOf(t, dir, "deploy/base/svc.yaml")

	if len(blame.Lines) != 1 {
		t.Fatalf("lines = %d, want 1", len(blame.Lines))
	}
}

// A SHA-256 repository writes sixty-four zeros for an uncommitted line, so a
// forty-zero constant would attribute those lines to a commit named entirely
// with zeros.
func TestParseBlameMarksASha256ZeroName(t *testing.T) {
	sha := strings.Repeat("0", 64)
	blame := parseBlame(sha + " 1 1 1\nauthor Not Committed Yet\nsummary x\n\tone\n")

	if len(blame.Commits) != 1 {
		t.Fatalf("commits = %d, want 1", len(blame.Commits))
	}
	if !blame.Commits[0].Uncommitted {
		t.Errorf("commit = %+v, want it marked uncommitted", blame.Commits[0])
	}
}

// A real SHA is not a zero SHA, however few non-zero digits it has.
func TestParseBlameKeepsACommitWithLeadingZeros(t *testing.T) {
	sha := strings.Repeat("0", 39) + "1"
	blame := parseBlame(sha + " 1 1 1\nauthor Someone\n\tone\n")

	if blame.Commits[0].Uncommitted {
		t.Errorf("commit = %+v, want it treated as a real commit", blame.Commits[0])
	}
}

// A record this parser cannot read costs its own line, not the file's — the
// rule status.go's parse already documents.
func TestParseBlameSkipsUnreadableRecords(t *testing.T) {
	blame := parseBlame("truncated\nabc 1 1 1\nauthor Someone\n\tone\n")

	if len(blame.Lines) != 1 {
		t.Fatalf("lines = %v, want the one readable entry", blame.Lines)
	}
	if blame.Commits[blame.Lines[0]].Author != "Someone" {
		t.Errorf("author = %q, want the readable record's", blame.Commits[blame.Lines[0]].Author)
	}
}

// A line number git skipped leaves one blank entry. The alternative — appending
// in arrival order — would shift every attribution below the gap by one, which
// is a wrong answer rather than a missing one.
func TestParseBlameLeavesASkippedLineUnattributed(t *testing.T) {
	blame := parseBlame("abc 1 1 1\nauthor Someone\n\tone\nabc 3 3 1\n\tthree\n")

	if len(blame.Lines) != 3 {
		t.Fatalf("lines = %v, want three entries", blame.Lines)
	}
	if blame.Lines[1] != unattributed {
		t.Errorf("line 2 = %d, want %d", blame.Lines[1], unattributed)
	}
	if blame.Lines[0] != blame.Lines[2] {
		t.Errorf("lines = %v, want line 3 attributed to the same commit as line 1", blame.Lines)
	}
}

// A group header whose line number is not one is a malformed record, and it
// opens no entry: believing it would put an entry at a line the file has no
// content for.
func TestParseBlameSkipsAHeaderWithoutAUsableLineNumber(t *testing.T) {
	for _, header := range []string{"abc 1 zero 1", "abc 1 0 1", "abc 1 -2 1"} {
		blame := parseBlame(header + "\nauthor Someone\n\tone\n")

		if len(blame.Lines) != 0 {
			t.Errorf("parseBlame(%q) lines = %v, want none", header, blame.Lines)
		}
	}
}

// A content line arriving with no entry open is a record out of order. It is
// dropped rather than attributed to whatever entry closed before it.
func TestParseBlameIgnoresContentWithNoEntryOpen(t *testing.T) {
	blame := parseBlame("\tstray\nabc 1 1 1\nauthor Someone\n\tone\n")

	if len(blame.Lines) != 1 {
		t.Fatalf("lines = %v, want the one real entry", blame.Lines)
	}
	if blame.Commits[blame.Lines[0]].Author != "Someone" {
		t.Errorf("author = %q, want the real entry's", blame.Commits[blame.Lines[0]].Author)
	}
}

// A line number the output could not be describing is a malformed record. It
// is dropped rather than believed: growing the slice to whatever number was
// parsed turns one bad digit into an allocation the size of that digit.
func TestParseBlameDropsALineNumberBeyondTheOutput(t *testing.T) {
	blame := parseBlame("abc 1 2147483000 1\nauthor Someone\n\tone\n")

	if len(blame.Lines) != 0 {
		t.Fatalf("lines = %d, want none for a record naming an impossible line", len(blame.Lines))
	}
}

// The bound must not reject a real blame. One record per line plus the headers
// leaves it far above any line number git will print for the file.
func TestParseBlameKeepsEveryLineOfARealisticBlame(t *testing.T) {
	var out strings.Builder
	const lines = 200
	for i := 1; i <= lines; i++ {
		out.WriteString("abc " + strconv.Itoa(i) + " " + strconv.Itoa(i) + " 1\n\tcontent\n")
	}

	blame := parseBlame(out.String())

	if len(blame.Lines) != lines {
		t.Fatalf("lines = %d, want %d", len(blame.Lines), lines)
	}
}

// A timestamp git could not print as a number costs the date, not the entry.
func TestParseBlameKeepsACommitWithAnUnreadableTime(t *testing.T) {
	blame := parseBlame("abc 1 1 1\nauthor Someone\nauthor-time later\nsummary x\n\tone\n")

	commit := blame.Commits[0]
	if commit.AuthorTime != 0 {
		t.Errorf("authorTime = %d, want 0", commit.AuthorTime)
	}
	if commit.Author != "Someone" || commit.Summary != "x" {
		t.Errorf("commit = %+v, want the readable fields kept", commit)
	}
}

// A summary is a sentence, and its first word is not a header key. This is why
// the parser tracks whether an entry is open rather than matching on shape.
func TestParseBlameKeepsAWholeSummaryLine(t *testing.T) {
	blame := parseBlame("abc 1 1 1\nsummary author of the change\n\tone\n")

	if got := blame.Commits[0].Summary; got != "author of the change" {
		t.Errorf("summary = %q, want the whole line", got)
	}
	if got := blame.Commits[0].Author; got != "" {
		t.Errorf("author = %q, want none — the summary is not an author header", got)
	}
}
