package pty

// ring is a fixed-capacity byte buffer holding the most recent bytes written
// to it.
//
// It is the mechanism behind the "a session survives having nobody reading it"
// rule. Writing never blocks and never fails: the alternative — an unbounded
// buffer — turns a terminal nobody is watching into a memory leak, and
// back-pressure onto the PTY turns it into a frozen shell. Dropping the oldest
// output is the only option that costs the user nothing they were still
// looking at.
//
// ring is not safe for concurrent use; the session owning it holds the lock.
type ring struct {
	buf   []byte
	start int // index of the oldest byte held
	size  int // bytes currently held
}

// newRing returns a ring holding at most capacity bytes. capacity must be
// positive.
func newRing(capacity int) *ring {
	return &ring{buf: make([]byte, capacity)}
}

// write appends p, evicting the oldest bytes when there is not enough room.
func (r *ring) write(p []byte) {
	capacity := len(r.buf)

	// A single write larger than the whole buffer makes every byte already
	// held unreachable, so only p's own tail survives.
	if len(p) >= capacity {
		copy(r.buf, p[len(p)-capacity:])
		r.start, r.size = 0, capacity
		return
	}

	end := (r.start + r.size) % capacity
	n := copy(r.buf[end:], p)
	copy(r.buf, p[n:])

	if overflow := r.size + len(p) - capacity; overflow > 0 {
		r.start = (r.start + overflow) % capacity
		r.size = capacity
		return
	}
	r.size += len(p)
}

// snapshot returns a copy of the held bytes, oldest first. The caller owns the
// result; the ring keeps writing into its own storage.
func (r *ring) snapshot() []byte {
	out := make([]byte, r.size)
	n := copy(out, r.buf[r.start:min(r.start+r.size, len(r.buf))])
	copy(out[n:], r.buf[:r.size-n])
	return out
}
