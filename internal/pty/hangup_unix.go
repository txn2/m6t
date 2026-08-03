//go:build !windows

package pty

import (
	"fmt"
	"os"
	"syscall"
)

// hangup asks the child to end the way closing a terminal window does, giving
// a shell the chance to run its exit traps.
func hangup(proc *os.Process) error {
	return signalGroup(proc, syscall.SIGHUP)
}

// forceKill ends the child unconditionally. It is the follow-up for a child
// that ignored the hangup.
func forceKill(proc *os.Process) error {
	return signalGroup(proc, syscall.SIGKILL)
}

// signalGroup signals the child's whole process group, falling back to the
// child alone if the group cannot be determined.
//
// The group is the point. go-pty starts the child in its own session, so a
// shell that has spawned `claude` or `vim` is the leader of a group containing
// them. Signaling only the shell would reap the shell and orphan everything
// it started — which is exactly the "no zombie processes" failure this is
// written to avoid.
func signalGroup(proc *os.Process, sig syscall.Signal) error {
	if pgid, err := syscall.Getpgid(proc.Pid); err == nil {
		if err := syscall.Kill(-pgid, sig); err != nil {
			return fmt.Errorf("signaling process group %d: %w", pgid, err)
		}
		return nil
	}
	if err := proc.Signal(sig); err != nil {
		return fmt.Errorf("signaling process %d: %w", proc.Pid, err)
	}
	return nil
}
