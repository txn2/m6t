package git

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/txn2/m6t/internal/gitexec"
)

// Per-line attribution (#52): who last touched each line of one file, and
// when. It is a reader like status.go, and for the same reason it is safe to
// run whenever the editor asks — `git blame` writes nothing.
//
// What it reads is the file *on disk*, not the editor's buffer. That is not a
// limitation to work around: blame's answer is a line number, and a buffer
// with an unsaved insertion in it has different line numbers from the file
// git measured. The UI clears the column rather than shifting it (#52), and
// this package is the reason it can — it reports what git said, and nothing
// here guesses at what an unsaved edit would have done to it.

// ErrInvalidPath is a path that would address something outside the project's
// worktree.
//
// Like ErrInvalidRef it is a rejection rather than a git failure: no
// subprocess runs. It exists because the bound surface is a public API
// (CLAUDE.md), and a caller that is not the file tree can hand this package a
// path the file tree would never produce.
var ErrInvalidPath = errors.New("not a path inside the project")

// The porcelain header keys this package reads. The format carries the
// committer's name and time as well, and neither is read: a blame column
// answers "who wrote this line", and a rebase or a patch applied on someone's
// behalf makes the committer a different person from the one who did.
const (
	blameAuthor     = "author"
	blameAuthorTime = "author-time"
	blameSummary    = "summary"
)

// blameHeaderFields is the shortest group header porcelain emits:
// `<sha> <origLine> <finalLine>`. The first line of a group carries a fourth
// field, the number of lines in it, which this package does not need — every
// line in the group gets its own header anyway.
const blameHeaderFields = 3

// How a porcelain timestamp is read: base ten, into the width AuthorTime is
// declared at. They are named because revive counts a bare `10, 64` as two
// magic numbers, and it is right that a base and a bit width read alike at a
// call site. Sixty-four rather than the platform int: a 32-bit build would
// otherwise stop parsing author times in 2038.
const (
	decimalBase   = 10
	timestampBits = 64
)

// unattributed is the commit index of a line the blame did not cover. See
// (*blameParser).close for when that can happen, which is: not through git.
const unattributed = -1

// BlameCommit is one commit that a file's lines are attributed to.
type BlameCommit struct {
	// SHA is the full object name, as git printed it.
	SHA string `json:"sha"`

	// Author is the name on the commit, "" when git reported none.
	Author string `json:"author"`

	// AuthorTime is when the author wrote it, in Unix seconds. The zone git
	// also reports is dropped: the column shows a date, and a date rendered in
	// the reader's own zone is the one they can compare against today.
	AuthorTime int64 `json:"authorTime"`

	// Summary is the commit's subject line.
	Summary string `json:"summary"`

	// Uncommitted marks git's all-zero SHA — the one it attributes work that
	// is in the working tree and in no commit. Such a "commit" has no author
	// and no date worth showing, so the UI marks the line instead of naming
	// someone.
	Uncommitted bool `json:"uncommitted"`
}

// Blame is one file's attribution, in the shape git's porcelain format states
// it: the commits once each, and a line-by-line reference into them.
type Blame struct {
	// Commits is each distinct commit, in the order its first line appeared.
	// Never nil: it crosses the bridge as JSON.
	Commits []BlameCommit `json:"commits"`

	// Lines is one index into Commits per line of the file, line 1 first. A
	// line the blame did not cover holds -1, which is not reachable through
	// git — see (*blameParser).close.
	Lines []int `json:"lines"`
}

// LoadBlame attributes each line of a file to the commit that last touched it.
//
// path is root-relative and slash-separated, the form the file tree and the
// editor already use. A path git cannot blame — one that has never been
// committed, one it is ignoring — is an error carrying git's own stderr, not
// an empty blame: "no attribution" and "this file has no history" read
// identically as a blank column, and only one of them is worth showing the
// user a reason for.
func LoadBlame(root, path string) (Blame, error) {
	if err := validatePath(path); err != nil {
		return Blame{}, err
	}
	// The `--` is what makes the argument a path rather than a revision. It is
	// also why a file whose name begins with a dash needs no rejection below:
	// after the separator, `-f.yaml` is a file.
	out, err := gitexec.Read(root, "blame", "--porcelain", "--", path)
	if err != nil {
		return Blame{}, err
	}
	return parseBlame(out), nil
}

// validatePath rejects a path that would address something outside the
// project's worktree.
//
// git runs with `-C root` and would refuse an escaping pathspec itself, with a
// message about being outside the repository. This runs first anyway: the
// check is one string scan against a subprocess, and "git happened to say no"
// is a weaker guarantee than "we never asked it".
//
// A backslash is treated as a separator on every platform, so `..\..\etc` is
// refused on Linux too. That costs the ability to blame a file with a
// backslash in its name on a Unix filesystem, which is a name no manifest
// repository has and not a trade worth reversing.
func validatePath(path string) error {
	if path == "" || strings.ContainsRune(path, 0) {
		return fmt.Errorf(rejectedFormat, path, ErrInvalidPath)
	}
	if strings.HasPrefix(path, "/") || filepath.IsAbs(path) {
		return fmt.Errorf(rejectedFormat, path, ErrInvalidPath)
	}
	if slices.Contains(strings.FieldsFunc(path, isPathSeparator), "..") {
		return fmt.Errorf(rejectedFormat, path, ErrInvalidPath)
	}
	return nil
}

func isPathSeparator(r rune) bool {
	return r == '/' || r == '\\'
}

// parseBlame reads `git blame --porcelain`.
//
// The format states a commit's details once, on the first line attributed to
// it, and refers back to it by SHA on every line after. This keeps that shape
// rather than flattening it: a 5,000-line file that came from one commit is
// one commit record and 5,000 indices, not 5,000 copies of an author and a
// timestamp crossing the bridge.
//
// A malformed record is skipped rather than failing the read, the same rule
// status.go's parse documents: a column is a view, and one line this version
// cannot read should cost that line's entry, not the file's.
func parseBlame(out string) Blame {
	parser := blameParser{
		index:   map[string]int{},
		commits: []BlameCommit{},
		lines:   []int{},
		// The file cannot have more lines than the output does: every line of
		// it costs at least the tab-prefixed record carrying its content. That
		// makes this a bound derived from the input rather than a number
		// somebody picked, and it is what stops a line number the parser reads
		// out of a malformed record from sizing an allocation. See close.
		limit: strings.Count(out, "\n") + 1,
	}
	for line := range strings.SplitSeq(out, "\n") {
		parser.read(line)
	}
	return Blame{Commits: parser.commits, Lines: parser.lines}
}

// blameParser accumulates one file's blame across the format's three kinds of
// line: a group header that opens an entry, extended headers describing its
// commit, and the file's own content, tab-prefixed, that closes it.
type blameParser struct {
	index   map[string]int
	commits []BlameCommit
	lines   []int

	// limit is the highest line number this blame can be about, derived in
	// parseBlame from the size of the output.
	limit int

	// sha and line are the entry currently open; inEntry says whether one is,
	// which is what tells a `summary ...` header apart from the group header
	// that opens the next entry — both are `<word> <rest>`.
	sha     string
	line    int
	inEntry bool
}

func (p *blameParser) read(raw string) {
	switch {
	case strings.HasPrefix(raw, "\t"):
		p.close()
	case !p.inEntry:
		p.open(raw)
	default:
		p.header(raw)
	}
}

// open reads a group header, `<sha> <origLine> <finalLine> [<numLines>]`, and
// registers its commit the first time that SHA appears.
func (p *blameParser) open(raw string) {
	fields := strings.Fields(raw)
	if len(fields) < blameHeaderFields {
		return
	}
	final, err := strconv.Atoi(fields[2])
	if err != nil || final < 1 {
		return
	}
	p.sha, p.line, p.inEntry = fields[0], final, true
	if _, seen := p.index[p.sha]; !seen {
		p.index[p.sha] = len(p.commits)
		p.commits = append(p.commits, BlameCommit{
			SHA:         p.sha,
			Uncommitted: uncommitted(p.sha),
		})
	}
}

// header folds one `key value` record into the open entry's commit.
func (p *blameParser) header(raw string) {
	key, value, ok := strings.Cut(raw, fieldSeparator)
	if !ok {
		return
	}
	commit := &p.commits[p.index[p.sha]]
	switch key {
	case blameAuthor:
		commit.Author = value
	case blameAuthorTime:
		// A timestamp git could not print as a number leaves the zero value,
		// which the UI shows as no date. The author and the summary are still
		// worth showing without it.
		if seconds, err := strconv.ParseInt(value, decimalBase, timestampBits); err == nil {
			commit.AuthorTime = seconds
		}
	case blameSummary:
		commit.Summary = value
	}
}

// close records the attribution of the line whose content just arrived.
//
// The entry is placed at the line number git gave it rather than appended, and
// any line the output skipped keeps `unattributed`. Neither case is reachable
// through git — porcelain emits every line of the file, in order — and that is
// exactly why it is worth placing rather than appending: if the output ever
// does skip a line, one blank entry is a better failure than every attribution
// below it being off by one.
func (p *blameParser) close() {
	if !p.inEntry {
		return
	}
	// A line number past what the output could be describing is a malformed
	// record, and the record is dropped rather than believed: the alternative
	// is growing the slice to whatever number was parsed, which turns one bad
	// digit into an allocation the size of that digit.
	if p.line > p.limit {
		p.inEntry = false
		return
	}
	for len(p.lines) < p.line {
		p.lines = append(p.lines, unattributed)
	}
	p.lines[p.line-1] = p.index[p.sha]
	p.inEntry = false
}

// uncommitted reports git's all-zero SHA, which it attributes lines that are
// in the working tree and in no commit.
//
// It is matched by shape rather than against a constant of forty zeros because
// a repository created with SHA-256 object names writes sixty-four of them.
func uncommitted(sha string) bool {
	return sha != "" && strings.Trim(sha, "0") == ""
}
