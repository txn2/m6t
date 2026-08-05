package app

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/txn2/m6t/internal/git"
	"github.com/txn2/m6t/internal/stream"
)

// gitRepoDir builds a real repository, unlike repoDir's bare .git directory:
// the binding runs the actual git binary, so a fake worktree would only
// exercise the not-a-repository path.
func gitRepoDir(t *testing.T) string {
	t.Helper()
	dir := repoDir(t, "infra")
	if err := os.RemoveAll(filepath.Join(dir, ".git")); err != nil {
		t.Fatalf("clearing the placeholder .git: %v", err)
	}
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.invalid"},
		{"config", "user.name", "m6t tests"},
	} {
		cmd := exec.CommandContext(t.Context(), "git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("fixture: git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	return dir
}

func TestGitStatusReportsTheWorkingTreeThroughTheBinding(t *testing.T) {
	a := testApp(t)
	dir := gitRepoDir(t)

	if err := os.WriteFile(filepath.Join(dir, "deploy.yaml"), []byte("kind: Deployment\n"), 0o600); err != nil {
		t.Fatalf("writing a manifest: %v", err)
	}

	status, err := a.GitStatus(dir)
	if err != nil {
		t.Fatalf("GitStatus: %v", err)
	}
	if status.Availability != git.Available {
		t.Fatalf("availability = %q, want %q", status.Availability, git.Available)
	}
	if len(status.Files) != 1 || status.Files[0].Path != "deploy.yaml" {
		t.Fatalf("files = %+v, want one untracked deploy.yaml", status.Files)
	}
	if status.Files[0].Worktree != git.StateUntracked {
		t.Errorf("deploy.yaml worktree = %q, want %q", status.Files[0].Worktree, git.StateUntracked)
	}
}

// The degraded states must survive the binding as states. A wrapper that
// turned "not a repository" into an error would put an error box in front of
// the user for a condition the status bar is meant to explain.
func TestGitStatusReportsANonRepositoryWithoutAnError(t *testing.T) {
	a := testApp(t)

	status, err := a.GitStatus(t.TempDir())
	if err != nil {
		t.Fatalf("GitStatus: %v", err)
	}
	if status.Availability != git.NotARepository {
		t.Errorf("availability = %q, want %q", status.Availability, git.NotARepository)
	}
}

// A real git failure keeps its own words and gains the project it happened
// in — the binding wraps, it does not translate (DESIGN.md §7).
func TestGitStatusWrapsARealFailureWithTheProjectPath(t *testing.T) {
	a := testApp(t)
	missing := filepath.Join(t.TempDir(), "was-here")

	if _, err := a.GitStatus(missing); err == nil {
		t.Fatal("GitStatus succeeded for a path that does not exist")
	} else if !strings.Contains(err.Error(), missing) {
		t.Errorf("error = %q, want it to name the project path", err)
	}
}

// The composition test for #8's wiring.
//
// internal/watch is tested against its own Events seam and internal/stream
// against a fake producer, which leaves the adapter between them — the one
// place that knows a filesystem change means two different things to the UI —
// untested by construction. This is the same argument
// TestATerminalSessionEchoesOverTheStreamSocket makes for the PTY adapter.
func TestAWatcherBatchPublishesBothATreeAndAGitEvent(t *testing.T) {
	application, endpoint := startApp(t)
	events := dialEvents(t, endpoint)

	watchBridge{streams: application.streams}.PublishTreeChanged("/repo", []string{".", "manifests"})

	first := events.awaitFrame()
	second := events.awaitFrame()

	byType := map[string]eventFrame{first.Type: first, second.Type: second}
	tree, sawTree := byType["tree"]
	gitEvent, sawGit := byType["git"]
	if !sawTree || !sawGit {
		t.Fatalf("one watcher batch produced %q and %q, want a tree and a git event",
			first.Type, second.Type)
	}
	if tree.Payload.Root != "/repo" || gitEvent.Payload.Root != "/repo" {
		t.Errorf("roots = %q and %q, want /repo for both",
			tree.Payload.Root, gitEvent.Payload.Root)
	}
	if len(tree.Payload.Dirs) != 2 {
		t.Errorf("tree dirs = %v, want the batch's two directories", tree.Payload.Dirs)
	}
	if len(gitEvent.Payload.Dirs) != 0 {
		t.Errorf("git dirs = %v; the git event carries no directories", gitEvent.Payload.Dirs)
	}
}

// eventFrame is an /events message decoded to what these tests assert on.
type eventFrame struct {
	Type    string `json:"type"`
	Payload struct {
		Root string   `json:"root"`
		Dirs []string `json:"dirs"`
	} `json:"payload"`
}

// eventSocket is a test's side of the backend-push channel.
type eventSocket struct {
	t  *testing.T
	ws *websocket.Conn
}

// dialEvents opens /events the way the frontend does, with the launch token
// offered as a subprotocol.
func dialEvents(t *testing.T, endpoint stream.Endpoint) *eventSocket {
	t.Helper()

	dialer := &websocket.Dialer{
		Subprotocols: []string{"m6t.v1", "m6t.token." + endpoint.Token},
	}
	url := "ws://127.0.0.1:" + strconv.Itoa(endpoint.Port) + "/events"
	ws, resp, err := dialer.Dial(url, http.Header{})
	if resp != nil {
		defer func() { _ = resp.Body.Close() }()
	}
	if err != nil {
		t.Fatalf("dialing %s: %v", url, err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	return &eventSocket{t: t, ws: ws}
}

func (e *eventSocket) awaitFrame() eventFrame {
	e.t.Helper()

	if err := e.ws.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		e.t.Fatalf("setting a read deadline: %v", err)
	}
	_, data, err := e.ws.ReadMessage()
	if err != nil {
		e.t.Fatalf("reading from the event socket: %v", err)
	}
	var frame eventFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		e.t.Fatalf("decoding %q: %v", data, err)
	}
	return frame
}
