package pty

import (
	"bytes"
	"strings"
	"testing"
)

func TestRingHoldsWhatFitsInOrder(t *testing.T) {
	r := newRing(8)
	r.write([]byte("abc"))
	r.write([]byte("de"))

	if got := string(r.snapshot()); got != "abcde" {
		t.Errorf("snapshot = %q, want %q", got, "abcde")
	}
}

func TestRingEvictsOldestOnceFull(t *testing.T) {
	r := newRing(4)
	r.write([]byte("abcd"))
	r.write([]byte("ef"))

	// "ab" is the oldest and must be the part that went.
	if got := string(r.snapshot()); got != "cdef" {
		t.Errorf("snapshot = %q, want %q", got, "cdef")
	}
}

func TestRingWrapsAroundTheEndOfItsStorage(t *testing.T) {
	r := newRing(5)
	r.write([]byte("abcd"))
	r.write([]byte("efg")) // wraps past the end of the backing array

	if got := string(r.snapshot()); got != "cdefg" {
		t.Errorf("snapshot = %q, want %q", got, "cdefg")
	}
}

func TestRingKeepsOnlyTheTailOfAnOversizedWrite(t *testing.T) {
	r := newRing(4)
	r.write([]byte("xy"))
	r.write([]byte("abcdefgh"))

	if got := string(r.snapshot()); got != "efgh" {
		t.Errorf("snapshot = %q, want %q", got, "efgh")
	}
}

func TestRingSnapshotDoesNotAliasTheBuffer(t *testing.T) {
	r := newRing(4)
	r.write([]byte("abcd"))

	snap := r.snapshot()
	r.write([]byte("wxyz"))

	if got := string(snap); got != "abcd" {
		t.Errorf("snapshot changed to %q after a later write; it must be a copy", got)
	}
}

func TestRingNeverExceedsItsCapacity(t *testing.T) {
	const capacity = 16
	r := newRing(capacity)
	for range 100 {
		r.write([]byte("0123456789"))
	}

	snap := r.snapshot()
	if len(snap) != capacity {
		t.Errorf("snapshot is %d bytes, want the capacity %d", len(snap), capacity)
	}
	// 1000 bytes of a repeating 10-byte cycle: the last 16 end "...6789".
	if !bytes.HasSuffix(snap, []byte("6789")) {
		t.Errorf("snapshot %q does not end with the most recent bytes", snap)
	}
}

func TestRingEmptySnapshotIsEmpty(t *testing.T) {
	if got := newRing(8).snapshot(); len(got) != 0 {
		t.Errorf("a ring nothing was written to snapshots as %q, want empty", got)
	}
}

// The scrollback is what a late consumer replays, so its capacity is a product
// decision (DESIGN.md §8), not an implementation detail free to drift.
func TestScrollbackIsTheDocumentedSize(t *testing.T) {
	if want := 256 * 1024; scrollbackBytes != want {
		t.Errorf("scrollbackBytes = %d, want %d", scrollbackBytes, want)
	}
}

func TestRingHandlesAWriteExactlyItsCapacity(t *testing.T) {
	r := newRing(4)
	r.write([]byte("ab"))
	r.write([]byte("wxyz"))

	if got := string(r.snapshot()); got != "wxyz" {
		t.Errorf("snapshot = %q, want %q", got, "wxyz")
	}
}

func TestRingAccumulatesAcrossManySmallWrites(t *testing.T) {
	r := newRing(1024)
	var want strings.Builder
	for i := range 50 {
		chunk := strings.Repeat(string(rune('a'+i%26)), 3)
		r.write([]byte(chunk))
		want.WriteString(chunk)
	}

	if got := string(r.snapshot()); got != want.String() {
		t.Errorf("snapshot = %q, want %q", got, want.String())
	}
}
