package stream

import (
	"encoding/json"
	"runtime"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// chunkBytes matches the PTY service's read size, so these tests move output in
// the units the real producer does.
const chunkBytes = 32 << 10

// streamedBytes is the throughput the issue's acceptance criteria name. At the
// chunk size above it is 1600 frames, which is a fraction of a second of
// loopback copying — the size is about memory behavior, not duration.
const streamedBytes = 50 << 20

// streamTotals is what a client observed over one terminal stream.
type streamTotals struct {
	received int64
	dropped  int64
	exitCode int
	sawExit  bool
}

// drainStream reads a terminal stream to its close, accounting for every byte:
// what arrived, and what the server reported discarding.
func drainStream(t *testing.T, c *client) streamTotals {
	t.Helper()

	var totals streamTotals
	for {
		if err := c.ws.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
			t.Fatalf("setting a read deadline: %v", err)
		}
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
				t.Errorf("the stream ended with %v, want a normal closure", err)
			}
			return totals
		}
		if kind == websocket.BinaryMessage {
			totals.received += int64(len(data))
			continue
		}
		var frame serverFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatalf("decoding %q: %v", data, err)
		}
		switch frame.Type {
		case typeResync:
			totals.dropped += frame.Payload.DroppedBytes
		case typeExit:
			totals.exitCode, totals.sawExit = frame.Payload.Code, true
		}
	}
}

// produce hands the server a fixed volume of output and then ends the session.
func produce(t *testing.T, session *fakeSession, total int) {
	t.Helper()

	chunk := make([]byte, chunkBytes)
	for sent := 0; sent < total; sent += len(chunk) {
		session.output(t, chunk)
	}
	session.exit(0)
}

// The property this protects is the one that makes the transport usable at all:
// a webview that has stopped reading must not be able to stall the shell. The
// producer here completes while nothing is reading the socket, which it can only
// do if no send along the way blocked.
//
// The other half is that the loss is reported. A renderer told nothing would
// paint across a hole in an escape-sequence stream and corrupt the screen.
func TestASlowConsumerLosesOutputAndIsToldHowMuch(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)

	// Nothing reads until the producer is finished, so the socket buffers and the
	// outbound queue both fill and the queue starts discarding.
	produce(t, terminals.session(), streamedBytes)

	totals := drainStream(t, c)

	if totals.dropped == 0 {
		t.Fatalf("nothing was dropped after %d bytes with no reader; the queue is not bounded", streamedBytes)
	}
	if got := totals.received + totals.dropped; got != streamedBytes {
		t.Errorf("received %d + dropped %d = %d, want %d — every byte is delivered or reported",
			totals.received, totals.dropped, got, streamedBytes)
	}
	if !totals.sawExit {
		t.Error("no exit frame arrived; a queue full of output must not cost the client the exit status")
	}
}

// The acceptance criterion for throughput: 50MB of output moves through without
// the backend accumulating it. A server that buffered the stream instead of
// bounding it would need at least 50MB of heap to do so.
func TestFiftyMegabytesStreamWithoutUnboundedMemoryGrowth(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)

	before := heapInUse()

	drained := make(chan streamTotals, 1)
	go func() { drained <- drainStream(t, c) }()

	produce(t, terminals.session(), streamedBytes)
	totals := <-drained

	// Subtraction only where it cannot wrap: a heap that ended smaller than it
	// started has grown by nothing.
	if after := heapInUse(); after > before && after-before > memoryHeadroom {
		t.Errorf("heap in use grew by %d bytes while streaming %d; the stream is being accumulated, not bounded",
			after-before, streamedBytes)
	}
	if got := totals.received + totals.dropped; got != streamedBytes {
		t.Errorf("received %d + dropped %d = %d, want %d",
			totals.received, totals.dropped, got, streamedBytes)
	}
	if !totals.sawExit || totals.exitCode != 0 {
		t.Errorf("exit seen = %v with code %d, want a clean exit", totals.sawExit, totals.exitCode)
	}
}

// memoryHeadroom bounds the heap growth the test above tolerates. It is far
// above what a bounded pipeline needs — the queue is 2MB and gorilla allocates
// per message — and far below the 50MB a server accumulating the stream would
// require, which is the distinction being measured.
const memoryHeadroom = 32 << 20

// heapInUse reports live heap after a collection, so the figure reflects what is
// retained rather than what has been allocated and abandoned.
func heapInUse() uint64 {
	runtime.GC()
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	return stats.HeapInuse
}

// The queue itself, in isolation: a full queue loses its oldest frame, and every
// lost byte is counted. Driving this through a socket could not distinguish
// "dropped the oldest" from "dropped the newest" — both lose the same volume,
// and only one preserves the newest output a terminal needs.
func TestTheOutboundQueueDropsTheOldestFrameAndCountsIt(t *testing.T) {
	const (
		capacity  = 2
		frameSize = 10
	)
	c := &conn{frames: make(chan frame, capacity), done: make(chan struct{})}

	for i := range 5 {
		c.send(websocket.BinaryMessage, []byte{byte(i), 1, 2, 3, 4, 5, 6, 7, 8, 9})
	}

	if got, want := c.dropped.Load(), int64(3*frameSize); got != want {
		t.Errorf("dropped = %d bytes, want %d", got, want)
	}
	if got := len(c.frames); got != capacity {
		t.Fatalf("queue holds %d frames, want %d", got, capacity)
	}

	// The survivors must be the NEWEST frames. A terminal that keeps the start of
	// a build log and discards the prompt is showing the user the wrong thing.
	for _, want := range []byte{3, 4} {
		f := <-c.frames
		if f.data[0] != want {
			t.Errorf("queued frame = %d, want frame %d — the oldest frames should have been dropped", f.data[0], want)
		}
	}
}

// Each marker is an increment, not a running total. The counter is taken and
// cleared in one step, which is what stops a single early stall from being
// re-reported for the rest of the session — and what makes the sums the tests
// above assert come out exact rather than inflated.
func TestReportingDropsClearsTheCounterAtomically(t *testing.T) {
	c := &conn{frames: make(chan frame, 1), done: make(chan struct{})}
	c.dropped.Store(4096)

	if got := c.dropped.Swap(0); got != 4096 {
		t.Errorf("first report = %d bytes, want 4096", got)
	}
	if got := c.dropped.Load(); got != 0 {
		t.Errorf("counter = %d after being reported, want 0", got)
	}

	c.send(websocket.BinaryMessage, make([]byte, 100))
	c.send(websocket.BinaryMessage, make([]byte, 100))
	if got := c.dropped.Load(); got != 100 {
		t.Errorf("counter = %d after one more drop, want 100 — the earlier total must not be carried", got)
	}
}
