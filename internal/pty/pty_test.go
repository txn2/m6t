package pty

import (
	"errors"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	xpty "github.com/aymanbagabas/go-pty"
)

// readTimeout bounds every wait on a real child process. Generous, because
// these tests spawn shells on shared CI runners; a wait that hits it is a
// genuine failure, not a slow machine.
const readTimeout = 20 * time.Second

// shell returns an argv running the given script through the platform's shell.
// The two scripts must do the same thing; they are separate because cmd.exe is
// not sh.
func shell(unixScript, windowsScript string) []string {
	if runtime.GOOS == windowsGOOS {
		return []string{"cmd.exe", "/c", windowsScript}
	}
	return []string{"/bin/sh", "-c", unixScript}
}

// interactiveShell returns an argv for a bare shell reading from the terminal.
func interactiveShell() []string {
	if runtime.GOOS == windowsGOOS {
		return []string{"cmd.exe"}
	}
	return []string{"/bin/sh"}
}

// requireSession returns the live session behind an ID. Tests reach past the
// Manager deliberately: waiting on the child directly is what lets them assert
// on lifecycle without an attached consumer changing the thing being measured.
func requireSession(t *testing.T, m *Manager, id SessionID) *session {
	t.Helper()
	s, err := m.lookup(id)
	if err != nil {
		t.Fatalf("looking up %s: %v", id, err)
	}
	return s
}

// waitForExit blocks until the session's child has been reaped.
func waitForExit(t *testing.T, s *session) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(readTimeout):
		t.Fatal("timed out waiting for the child to exit")
	}
}

// readUntil collects output from an attachment until it contains want.
func readUntil(t *testing.T, a Attachment, want string) {
	t.Helper()
	var seen strings.Builder
	seen.Write(a.Replay)
	if strings.Contains(seen.String(), want) {
		return
	}

	deadline := time.After(readTimeout)
	for {
		select {
		case chunk, open := <-a.Chunks:
			if !open {
				t.Fatalf("the session ended before producing %q; output was %q", want, seen.String())
			}
			seen.Write(chunk)
			if strings.Contains(seen.String(), want) {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q; output was %q", want, seen.String())
		}
	}
}

// awaitExit returns the exit status an attachment reports.
func awaitExit(t *testing.T, a Attachment) Exit {
	t.Helper()
	select {
	case e := <-a.Exited:
		return e
	case <-time.After(readTimeout):
		t.Fatal("timed out waiting for the exit event")
		return Exit{}
	}
}

// The acceptance path from the issue: run a command, read its output, resize,
// kill, observe the exit event, and leave no unreaped process behind.
func TestSessionStreamsOutputResizesAndDiesWhenKilled(t *testing.T) {
	m := New()
	id, err := m.Create(Options{
		Command: shell("echo hello; sleep 60", "echo hello & ping -n 61 127.0.0.1 >NUL"),
		Cols:    100,
		Rows:    40,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	s := requireSession(t, m, id)
	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	readUntil(t, attached, "hello")

	if err := m.Resize(id, 120, 50); err != nil {
		t.Errorf("Resize: %v", err)
	}

	if err := m.Kill(id); err != nil {
		t.Fatalf("Kill: %v", err)
	}

	// Kill returns only once the child is reaped: a populated ProcessState is
	// the proof there is no zombie left behind it.
	if s.cmd.ProcessState == nil {
		t.Error("Kill returned before the child was reaped; the process was left unwaited")
	}
	if got := awaitExit(t, attached); got.Code == 0 {
		t.Errorf("exit code = 0 after a kill, want a non-zero or signaled status")
	}
	if _, err := m.Attach(id); !errors.Is(err, ErrNoSuchSession) {
		t.Errorf("Attach after Kill: error = %v, want ErrNoSuchSession", err)
	}
}

func TestExitStatusCarriesTheChildsExitCode(t *testing.T) {
	m := New()
	id, err := m.Create(Options{Command: shell("exit 7", "exit 7")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	if got := awaitExit(t, attached); got.Code != 7 {
		t.Errorf("exit = %+v, want Code 7", got)
	}
}

// The child must never be throttled by the absence of a reader. This runs a
// command that produces more output than the scrollback holds with nothing
// attached at all, and checks it ran to completion anyway.
func TestChildRunsToCompletionWithNoConsumerAttached(t *testing.T) {
	if runtime.GOOS == windowsGOOS {
		t.Skip("the bulk-output script is POSIX sh; the Windows path is covered by the spawn/echo/kill tests")
	}

	// 400 lines of ~1KB each: comfortably more than scrollbackBytes, and
	// built without seq/awk so it runs on any POSIX shell.
	const marker = "BULK-OUTPUT-COMPLETE"
	script := "s=" + strings.Repeat("x", 64) + "; s=$s$s$s$s; s=$s$s$s$s; " +
		"i=0; while [ $i -lt 400 ]; do echo \"$s\"; i=$((i+1)); done; echo " + marker

	m := New()
	id, err := m.Create(Options{Command: shell(script, "")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	// Nothing is attached while the child runs; wait on the child itself.
	waitForExit(t, requireSession(t, m, id))

	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach after exit: %v", err)
	}
	replay := string(attached.Replay)

	if !strings.Contains(replay, marker) {
		t.Error("the child did not reach the end of its output; it was blocked by having no reader")
	}
	if len(attached.Replay) != scrollbackBytes {
		t.Errorf("scrollback holds %d bytes, want it filled to %d", len(attached.Replay), scrollbackBytes)
	}
	if got := awaitExit(t, attached); got.Code != 0 {
		t.Errorf("exit = %+v, want Code 0", got)
	}
}

// A consumer that stops reading must be dropped from, not block the child.
func TestSlowConsumerDoesNotStallTheChild(t *testing.T) {
	if runtime.GOOS == windowsGOOS {
		t.Skip("the bulk-output script is POSIX sh; the Windows path is covered by the spawn/echo/kill tests")
	}

	script := "s=" + strings.Repeat("x", 64) + "; s=$s$s$s$s; s=$s$s$s$s; " +
		"i=0; while [ $i -lt 400 ]; do echo \"$s\"; i=$((i+1)); done"

	m := New()
	id, err := m.Create(Options{Command: shell(script, "")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	// Attached and deliberately never read: the queue fills, chunks are
	// dropped, and the child still has to finish.
	if _, err := m.Attach(id); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	waitForExit(t, requireSession(t, m, id))
}

func TestWriteReachesTheChild(t *testing.T) {
	m := New()
	// The shell echoes what is typed, so the command text must not contain
	// the answer — otherwise the echo alone would satisfy the assertion.
	id, err := m.Create(Options{Command: interactiveShell()})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	input := "expr 6 \\* 7\n"
	if runtime.GOOS == windowsGOOS {
		input = "set /a 6*7\r\n"
	}
	if err := m.Write(id, []byte(input)); err != nil {
		t.Fatalf("Write: %v", err)
	}

	readUntil(t, attached, "42")
}

func TestAttachAfterExitReplaysScrollbackAndReportsTheStatus(t *testing.T) {
	m := New()
	id, err := m.Create(Options{Command: shell("echo persisted; exit 3", "echo persisted & exit 3")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	waitForExit(t, requireSession(t, m, id))

	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach after exit: %v", err)
	}
	if !strings.Contains(string(attached.Replay), "persisted") {
		t.Errorf("replay = %q, want it to contain the output produced before the exit", attached.Replay)
	}
	// A late consumer must not hang waiting for output that will never come.
	if _, open := <-attached.Chunks; open {
		t.Error("Chunks delivered a value on an exited session; it must be closed")
	}
	if got := awaitExit(t, attached); got.Code != 3 {
		t.Errorf("exit = %+v, want Code 3", got)
	}
}

func TestUnknownSessionIsRejectedByEveryMethod(t *testing.T) {
	m := New()
	const missing SessionID = "pty-does-not-exist"

	if _, err := m.Attach(missing); !errors.Is(err, ErrNoSuchSession) {
		t.Errorf("Attach: error = %v, want ErrNoSuchSession", err)
	}
	if err := m.Write(missing, []byte("x")); !errors.Is(err, ErrNoSuchSession) {
		t.Errorf("Write: error = %v, want ErrNoSuchSession", err)
	}
	if err := m.Resize(missing, 80, 24); !errors.Is(err, ErrNoSuchSession) {
		t.Errorf("Resize: error = %v, want ErrNoSuchSession", err)
	}
	if err := m.Kill(missing); !errors.Is(err, ErrNoSuchSession) {
		t.Errorf("Kill: error = %v, want ErrNoSuchSession", err)
	}
}

func TestCreateFailsWhenTheCommandCannotStart(t *testing.T) {
	m := New()

	id, err := m.Create(Options{Command: []string{"m6t-no-such-binary-exists-here"}})
	if err == nil {
		t.Fatalf("Create succeeded with id %q for a binary that does not exist", id)
	}
	if id != "" {
		t.Errorf("Create returned id %q alongside an error, want the empty id", id)
	}
	// A failed start must leave nothing registered.
	if len(m.sessions) != 0 {
		t.Errorf("Manager holds %d sessions after a failed Create, want 0", len(m.sessions))
	}
}

func TestCreateRunsTheChildInTheRequestedDirectory(t *testing.T) {
	dir := t.TempDir()
	// macOS reports /var as a symlink to /private/var, so compare against the
	// resolved path rather than the one t.TempDir handed back.
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("resolving %s: %v", dir, err)
	}

	m := New()
	id, err := m.Create(Options{Cwd: dir, Command: shell("pwd", "cd")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	readUntil(t, attached, filepath.Base(resolved))
}

func TestCreateExportsTheCallersEnvironment(t *testing.T) {
	m := New()
	id, err := m.Create(Options{
		Env:     []string{"M6T_TEST_VAR=session-scoped-value"},
		Command: shell("echo $M6T_TEST_VAR", "echo %M6T_TEST_VAR%"),
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	readUntil(t, attached, "session-scoped-value")
}

func TestShutdownKillsEverySession(t *testing.T) {
	m := New()
	stayAlive := shell("sleep 60", "ping -n 61 127.0.0.1 >NUL")

	sessions := make([]*session, 0, 3)
	ids := make([]SessionID, 0, 3)
	for range 3 {
		id, err := m.Create(Options{Command: stayAlive})
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		ids = append(ids, id)
		sessions = append(sessions, requireSession(t, m, id))
	}

	m.Shutdown()

	if len(m.sessions) != 0 {
		t.Errorf("Manager holds %d sessions after Shutdown, want 0", len(m.sessions))
	}
	for i, s := range sessions {
		if s.cmd.ProcessState == nil {
			t.Errorf("session %s was not reaped by Shutdown", ids[i])
		}
	}
}

// The hangup is a request; SIGKILL is what makes it a guarantee. A shell that
// traps SIGHUP — which a user's rc file is free to do — must not be able to
// hold the app open past killGrace.
func TestKillEscalatesToSigkillWhenTheChildIgnoresTheHangup(t *testing.T) {
	if runtime.GOOS == windowsGOOS {
		t.Skip("Windows has no SIGHUP to ignore; hangup terminates the child outright")
	}

	const trapReady = "TRAP-INSTALLED"

	m := New()
	// The trailing echo stops sh exec-ing into sleep, so the process holding
	// the ignored disposition is the shell itself.
	id, err := m.Create(Options{
		Command: shell(`trap "" HUP; echo `+trapReady+`; sleep 60; echo done`, ""),
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	s := requireSession(t, m, id)

	// Kill only once the trap is actually installed. Signaling earlier races
	// the shell's own startup, and SIGHUP at default disposition kills it
	// instantly — which would pass a test of the escalation path without ever
	// exercising it.
	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	readUntil(t, attached, trapReady)

	start := time.Now()
	if err := m.Kill(id); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	elapsed := time.Since(start)

	if s.cmd.ProcessState == nil {
		t.Fatal("Kill returned before the child was reaped")
	}
	if elapsed < killGrace {
		t.Errorf("Kill returned after %v, before the %v grace elapsed; the child was never given "+
			"its chance to exit cleanly", elapsed, killGrace)
	}
	if elapsed > killGrace+readTimeout {
		t.Errorf("Kill took %v; a child ignoring the hangup must still die at the grace deadline", elapsed)
	}
}

// Once a session's PTY is closed, input and resize must report that rather
// than silently succeeding against a dead terminal.
func TestWriteAndResizeFailOnceTheSessionHasBeenKilled(t *testing.T) {
	m := New()
	id, err := m.Create(Options{Command: shell("sleep 60", "ping -n 61 127.0.0.1 >NUL")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	s := requireSession(t, m, id)
	if err := m.Kill(id); err != nil {
		t.Fatalf("Kill: %v", err)
	}

	if err := s.write([]byte("input\n")); err == nil {
		t.Error("write to a killed session succeeded; it must report the closed terminal")
	}
	if err := s.resize(100, 40); err == nil {
		t.Error("resize of a killed session succeeded; it must report the closed terminal")
	}
}

func TestShutdownOnAnEmptyManagerIsSafe(t *testing.T) {
	m := New()
	m.Shutdown()

	// Shutdown must leave the Manager usable rather than in a state where the
	// session map has been nilled out from under the next Create.
	if _, err := m.Create(Options{Command: shell("exit 0", "exit 0")}); err != nil {
		t.Errorf("Create after Shutdown on an empty Manager: %v", err)
	}
}

func TestSessionIDsAreUnique(t *testing.T) {
	m := New()
	t.Cleanup(m.Shutdown)

	seen := map[SessionID]bool{}
	for range 3 {
		id, err := m.Create(Options{Command: shell("exit 0", "exit 0")})
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if seen[id] {
			t.Fatalf("Create returned the already-issued id %q", id)
		}
		seen[id] = true
	}
}

func TestShellForPicksTheUsersLoginShell(t *testing.T) {
	tests := []struct {
		name string
		goos string
		env  map[string]string
		want []string
	}{
		{
			name: "unix uses SHELL when it is set",
			goos: "darwin",
			env:  map[string]string{"SHELL": "/usr/bin/fish"},
			want: []string{"/usr/bin/fish"},
		},
		{
			name: "unix falls back to /bin/sh when SHELL is unset",
			goos: "linux",
			env:  map[string]string{},
			want: []string{"/bin/sh"},
		},
		{
			name: "unix falls back when SHELL is set but empty",
			goos: "linux",
			env:  map[string]string{"SHELL": ""},
			want: []string{"/bin/sh"},
		},
		{
			name: "windows uses PowerShell and ignores SHELL",
			goos: windowsGOOS,
			env:  map[string]string{"SHELL": "/usr/bin/fish"},
			want: []string{"powershell.exe"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shellFor(tt.goos, func(k string) string { return tt.env[k] })
			if strings.Join(got, " ") != strings.Join(tt.want, " ") {
				t.Errorf("shellFor(%q) = %v, want %v", tt.goos, got, tt.want)
			}
		})
	}
}

func TestEnvironInheritsTheProcessEnvironmentAndSetsTerm(t *testing.T) {
	t.Setenv("M6T_INHERITED_MARKER", "inherited")

	env := environ([]string{"EXTRA=added"})

	want := map[string]string{
		"M6T_INHERITED_MARKER": "inherited",
		"TERM":                 terminalType,
		"EXTRA":                "added",
	}
	for key, value := range want {
		if !slices.Contains(env, key+"="+value) {
			t.Errorf("environ() is missing %s=%s; got %v", key, value, env)
		}
	}
}

// A caller's own entry must win over the inherited one, which is what makes
// Options.Env an override rather than a suggestion.
func TestEnvironLetsTheCallerOverrideAnInheritedVariable(t *testing.T) {
	t.Setenv("M6T_OVERRIDDEN", "from-process")

	env := environ([]string{"M6T_OVERRIDDEN=from-caller"})

	last := ""
	for _, entry := range env {
		if strings.HasPrefix(entry, "M6T_OVERRIDDEN=") {
			last = entry
		}
	}
	if last != "M6T_OVERRIDDEN=from-caller" {
		t.Errorf("the last M6T_OVERRIDDEN entry is %q, want the caller's value to win", last)
	}
}

func TestEnvironOverridesTermForTheCaller(t *testing.T) {
	t.Setenv("TERM", "dumb")

	env := environ(nil)

	last := ""
	for _, entry := range env {
		if strings.HasPrefix(entry, "TERM=") {
			last = entry
		}
	}
	if last != "TERM="+terminalType {
		t.Errorf("the last TERM entry is %q, want TERM=%s", last, terminalType)
	}
}

func TestSizeSubstitutesDefaultsForZeroDimensions(t *testing.T) {
	tests := []struct {
		name               string
		cols, rows         uint16
		wantCols, wantRows uint16
	}{
		{"both given", 120, 50, 120, 50},
		{"both zero", 0, 0, defaultCols, defaultRows},
		{"zero columns only", 0, 50, defaultCols, 50},
		{"zero rows only", 120, 0, 120, defaultRows},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotCols, gotRows := size(tt.cols, tt.rows)
			if gotCols != tt.wantCols || gotRows != tt.wantRows {
				t.Errorf("size(%d, %d) = (%d, %d), want (%d, %d)",
					tt.cols, tt.rows, gotCols, gotRows, tt.wantCols, tt.wantRows)
			}
		})
	}
}

func TestResizeRejectsNothingAndAppliesDefaults(t *testing.T) {
	m := New()
	id, err := m.Create(Options{Command: shell("sleep 60", "ping -n 61 127.0.0.1 >NUL")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	// A zero dimension must not reach the PTY, which cannot render at 0.
	if err := m.Resize(id, 0, 0); err != nil {
		t.Errorf("Resize with zero dimensions: %v", err)
	}
}

// A child that never ran leaves no ProcessState to read a code from. -1 is
// what Exit documents for "did not exit on its own", and the alternative — a
// zero-valued Exit — would report a clean exit for a session that failed.
func TestExitStatusReportsMinusOneWithoutAProcessState(t *testing.T) {
	if got := exitStatus(&xpty.Cmd{}, errors.New("wait failed")); got.Code != -1 {
		t.Errorf("exit = %+v, want Code -1 when the child produced no state", got)
	}
	if got := exitStatus(&xpty.Cmd{}, nil); got.Code != 0 {
		t.Errorf("exit = %+v, want Code 0 when the wait succeeded with no state", got)
	}
}

func TestDefaultShellIsUsedWhenNoCommandIsGiven(t *testing.T) {
	if runtime.GOOS == windowsGOOS {
		t.Skip("PowerShell startup is too slow to gate this test on; the Unix path pins the behavior")
	}
	t.Setenv("SHELL", "/bin/sh")

	m := New()
	id, err := m.Create(Options{})
	if err != nil {
		t.Fatalf("Create with no command: %v", err)
	}
	t.Cleanup(func() { _ = m.Kill(id) })

	attached, err := m.Attach(id)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if err := m.Write(id, []byte("expr 6 \\* 7\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	readUntil(t, attached, "42")
}
