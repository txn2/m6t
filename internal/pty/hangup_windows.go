//go:build windows

package pty

import (
	"fmt"
	"os"
)

// hangup ends the child.
//
// Windows has no SIGHUP. A console application is ended by closing its
// pseudoconsole or by terminating the process outright, and go-pty owns the
// pseudoconsole handle, so termination is the honest option here. The
// consequence is that the killGrace window in session.kill buys a Windows
// child nothing — it is already gone when the grace period would have started.
func hangup(proc *os.Process) error {
	if err := proc.Kill(); err != nil {
		return fmt.Errorf("terminating process %d: %w", proc.Pid, err)
	}
	return nil
}

// forceKill ends the child unconditionally. On Windows there is nothing
// gentler than hangup to escalate from, so the two are the same call.
func forceKill(proc *os.Process) error {
	return hangup(proc)
}
