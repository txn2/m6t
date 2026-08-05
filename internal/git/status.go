package git

import (
	"errors"
	"strconv"
	"strings"
)

// The porcelain v2 record kinds this package reads, as the leading token of a
// record (git-status(1), "Porcelain Format Version 2").
//
// `!` (ignored) is absent deliberately: it only appears when --ignored is
// passed, and a file tree that showed a badge on every build artifact would
// bury the changes the user is actually looking at.
const (
	kindHeader    = "#"
	kindOrdinary  = "1"
	kindRenamed   = "2"
	kindUnmerged  = "u"
	kindUntracked = "?"
)

// Field counts per record kind, used to split a record without splitting the
// path — a path may contain spaces, so every SplitN below stops exactly one
// field before the path and takes the remainder whole.
const (
	ordinaryFields = 8  // XY sub mH mI mW hH hI path
	renamedFields  = 9  // XY sub mH mI mW hH hI Xscore path
	unmergedFields = 10 // XY sub m1 m2 m3 mW h1 h2 h3 path
)

// recordSeparator terminates every record under -z.
const recordSeparator = "\x00"

// fieldSeparator divides the fields within one record.
const fieldSeparator = " "

// Header keys of the --branch preamble.
const (
	headerOID         = "branch.oid"
	headerHead        = "branch.head"
	headerUpstream    = "branch.upstream"
	headerAheadBehind = "branch.ab"
)

// Header values that stand in for a missing one.
const (
	initialOID   = "(initial)"
	detachedHead = "(detached)"
)

// Load reports git's view of the working tree at root.
//
// A missing git binary and a path that is not a repository come back as a
// Status carrying the reason (NoGit, NotARepository) and no error: see
// Availability for why those are states rather than failures. Every other
// failure is an error carrying git's stderr.
func Load(root string) (Status, error) {
	// -z rather than the default: it drops git's C-style quoting of unusual
	// path names in favor of NUL-terminated records, which means paths with
	// spaces, quotes or non-UTF-8 bytes arrive as themselves instead of
	// through an escaping scheme this package would have to reverse
	// correctly on every platform.
	out, err := runGit(root, "status", "--porcelain=v2", "--branch", "-z")
	switch {
	case errors.Is(err, errNoGit):
		return statusFor(NoGit), nil
	case errors.Is(err, errNotARepository):
		return statusFor(NotARepository), nil
	case err != nil:
		return Status{}, err
	}
	return parse(out), nil
}

// parse turns porcelain v2 -z output into a Status.
//
// Unparseable records are skipped rather than failing the whole read: a
// status is a view, and one record this version does not recognize should
// cost its own badge, not every badge in the project.
func parse(out string) Status {
	status := statusFor(Available)
	records := splitRecords(out)

	for i := 0; i < len(records); i++ {
		kind, rest, ok := strings.Cut(records[i], fieldSeparator)
		if !ok {
			continue
		}
		if kind == kindHeader {
			applyHeader(&status.Branch, rest)
			continue
		}
		if entry, ok := entryOf(kind, rest, records, &i); ok {
			status.Files = append(status.Files, entry)
		}
	}
	return status
}

// entryOf reads one non-header record. It takes the record stream and the
// loop's cursor because a rename record consumes a second field — the one
// place a record and a separator do not line up one to one.
func entryOf(kind, rest string, records []string, i *int) (FileStatus, bool) {
	switch kind {
	case kindOrdinary:
		return ordinaryEntry(rest)
	case kindRenamed:
		return renamedEntry(rest, takeNext(records, i))
	case kindUnmerged:
		return unmergedEntry(rest)
	case kindUntracked:
		return FileStatus{Path: rest, Worktree: StateUntracked}, true
	default:
		return FileStatus{}, false
	}
}

// splitRecords cuts -z output into records, dropping the empty tail every
// NUL-terminated stream ends with.
func splitRecords(out string) []string {
	records := strings.Split(out, recordSeparator)
	if len(records) > 0 && records[len(records)-1] == "" {
		records = records[:len(records)-1]
	}
	return records
}

// takeNext consumes and returns the record after *i, or "" at the end of the
// stream — a truncated rename record loses its source path rather than
// reading past the end.
func takeNext(records []string, i *int) string {
	if *i+1 >= len(records) {
		return ""
	}
	*i++
	return records[*i]
}

// ordinaryEntry reads a `1` record: a tracked path that is not a rename.
func ordinaryEntry(rest string) (FileStatus, bool) {
	fields := strings.SplitN(rest, fieldSeparator, ordinaryFields)
	if len(fields) < ordinaryFields {
		return FileStatus{}, false
	}
	staged, worktree, ok := statesOf(fields[0])
	if !ok {
		return FileStatus{}, false
	}
	return FileStatus{Path: fields[ordinaryFields-1], Staged: staged, Worktree: worktree}, true
}

// renamedEntry reads a `2` record plus the source path that follows it.
func renamedEntry(rest, origPath string) (FileStatus, bool) {
	fields := strings.SplitN(rest, fieldSeparator, renamedFields)
	if len(fields) < renamedFields {
		return FileStatus{}, false
	}
	staged, worktree, ok := statesOf(fields[0])
	if !ok {
		return FileStatus{}, false
	}
	return FileStatus{
		Path:     fields[renamedFields-1],
		Staged:   staged,
		Worktree: worktree,
		OrigPath: origPath,
	}, true
}

// unmergedEntry reads a `u` record: a path with competing versions.
//
// Its XY pair is deliberately not decoded. The codes on an unmerged path
// describe which sides of the merge touched it (`UU`, `AA`, `DU`), not an
// index-versus-worktree split, so mapping them through statesOf would produce
// a staged/unstaged claim the repository does not support.
func unmergedEntry(rest string) (FileStatus, bool) {
	fields := strings.SplitN(rest, fieldSeparator, unmergedFields)
	if len(fields) < unmergedFields {
		return FileStatus{}, false
	}
	return FileStatus{Path: fields[unmergedFields-1], Conflicted: true}, true
}

// statesOf decodes an XY pair: X is the index against HEAD, Y the working
// tree against the index. The second return is false for a pair too short to
// be one, which is the only way an ordinary record ends up claiming nothing
// differs — git does not emit a record for an unchanged path.
func statesOf(xy string) (staged, worktree State, ok bool) {
	if len(xy) < 2 {
		return "", "", false
	}
	return stateOf(xy[0]), stateOf(xy[1]), true
}

// stateOf decodes one porcelain v2 status character.
//
// `.` is the only code that means "no difference on this side". Anything
// unrecognized is reported as a modification rather than as nothing: git only
// emits a record for a path that differs, so the honest reading of a code
// this version does not know is "it differs, in a way not worth a distinct
// badge" — and the alternative, dropping the side, would silently take a
// file's badge away the first time git grows a code.
func stateOf(code byte) State {
	switch code {
	case '.':
		return ""
	case 'A':
		return StateAdded
	case 'D':
		return StateDeleted
	case 'R':
		return StateRenamed
	case 'C':
		return StateCopied
	default:
		// 'M' and 'T' (typechange) both land here by name; the tree shows one
		// badge per path, and "the content is not what it was" is what it means.
		return StateModified
	}
}

// applyHeader folds one `# key value` preamble record into the branch state.
func applyHeader(branch *Branch, rest string) {
	key, value, ok := strings.Cut(rest, fieldSeparator)
	if !ok {
		return
	}
	switch key {
	case headerOID:
		// A repository with no commits reports (initial) here while
		// branch.head still names the branch HEAD would point at.
		branch.Unborn = value == initialOID
	case headerHead:
		if value == detachedHead {
			branch.Detached = true
			return
		}
		branch.Name = value
	case headerUpstream:
		branch.Upstream = value
	case headerAheadBehind:
		branch.Ahead, branch.Behind = aheadBehind(value)
	}
}

// aheadBehind reads a `+<ahead> -<behind>` pair. A malformed count is zero:
// the branch line is decoration, and a status whose file badges are correct
// should not be discarded over it.
func aheadBehind(value string) (ahead, behind int) {
	plus, minus, ok := strings.Cut(value, fieldSeparator)
	if !ok {
		return 0, 0
	}
	return signedCount(plus, "+"), signedCount(minus, "-")
}

// signedCount reads one count, requiring its sign so a reordered or truncated
// pair cannot be read as the other side's number.
func signedCount(field, sign string) int {
	digits, ok := strings.CutPrefix(field, sign)
	if !ok {
		return 0
	}
	n, err := strconv.Atoi(digits)
	if err != nil || n < 0 {
		return 0
	}
	return n
}
