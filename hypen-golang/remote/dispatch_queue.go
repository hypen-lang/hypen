package remote

import (
	"sync"

	"github.com/hypen-space/core/device"
)

// dispatchQueue serialises the action dispatches of one session with a
// negotiated device plane off the socket reader: the reader only enqueues, so a handler waiting on
// a device operation never stops the reader from delivering the device's
// answer. Dispatches start in arrival order and run one at a time (they
// hold the session's dispatch slot); a handler waiting on the device
// yields the slot (device.Waiter) so later dispatches run meanwhile, and
// resumes once it gets the slot back.
type dispatchQueue struct {
	slot chan struct{} // capacity 1: holding a token = holding the slot

	mu    sync.Mutex
	items []dispatchItem

	// setCurrent records the dispatch that holds the slot (nil = none).
	setCurrent func(*dispatchLease)
}

type dispatchItem struct {
	replayed bool
	run      func()
}

func newDispatchQueue(setCurrent func(*dispatchLease)) *dispatchQueue {
	return &dispatchQueue{slot: make(chan struct{}, 1), setCurrent: setCurrent}
}

// enqueue schedules run after every earlier item has started.
func (q *dispatchQueue) enqueue(replayed bool, run func()) {
	q.mu.Lock()
	q.items = append(q.items, dispatchItem{replayed: replayed, run: run})
	q.mu.Unlock()
	go q.pump()
}

// pump takes the slot, then runs the oldest queued item (items are popped
// only while holding the slot, so they start in FIFO order).
func (q *dispatchQueue) pump() {
	q.slot <- struct{}{}
	q.mu.Lock()
	if len(q.items) == 0 {
		q.mu.Unlock()
		<-q.slot
		return
	}
	it := q.items[0]
	q.items = q.items[1:]
	q.mu.Unlock()
	q.runHeld(it)
}

// runInline runs an item on the caller's goroutine once the slot is free.
// Never call it from a handler of the same session (the slot is held).
func (q *dispatchQueue) runInline(replayed bool, run func()) {
	q.slot <- struct{}{}
	q.runHeld(dispatchItem{replayed: replayed, run: run})
}

func (q *dispatchQueue) runHeld(it dispatchItem) {
	l := newDispatchLease(q, it.replayed)
	q.setCurrent(l)
	defer l.finish()
	it.run()
}

// dispatchLease is one dispatch's hold on the slot; it implements
// device.Waiter. Several goroutines of one dispatch may wait at once: the
// slot is yielded while any waits and taken back when the last returns.
type dispatchLease struct {
	q        *dispatchQueue
	replayed bool

	mu        sync.Mutex
	cond      *sync.Cond
	held      bool
	done      bool
	acquiring bool
	waiters   int
}

func newDispatchLease(q *dispatchQueue, replayed bool) *dispatchLease {
	l := &dispatchLease{q: q, held: true, replayed: replayed}
	l.cond = sync.NewCond(&l.mu)
	return l
}

var _ device.Waiter = (*dispatchLease)(nil)

// BeginWait yields the slot (when this dispatch holds it).
func (l *dispatchLease) BeginWait() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.done {
		return
	}
	l.waiters++
	if l.waiters == 1 && l.held {
		l.held = false
		l.q.setCurrent(nil)
		<-l.q.slot
	}
}

// EndWait takes the slot back once no goroutine of this dispatch waits.
// One goroutine queues for the slot on the dispatch's behalf; others
// waiting to resume block on the lease until it arrives.
func (l *dispatchLease) EndWait() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.done || l.waiters == 0 {
		return
	}
	l.waiters--
	for !l.held && !l.done && l.waiters == 0 {
		if l.acquiring {
			l.cond.Wait()
			continue
		}
		l.acquiring = true
		l.mu.Unlock()
		l.q.slot <- struct{}{}
		l.mu.Lock()
		l.acquiring = false
		if l.done || l.waiters > 0 {
			// The dispatch finished, or a goroutine of it started waiting
			// again, while this one queued: hand the slot straight back.
			<-l.q.slot
		} else {
			l.held = true
			l.q.setCurrent(l)
		}
		l.cond.Broadcast()
	}
}

// finish ends the dispatch, releasing the slot if it holds it.
func (l *dispatchLease) finish() {
	l.mu.Lock()
	l.done = true
	held := l.held
	l.held = false
	if held {
		l.q.setCurrent(nil)
	}
	l.cond.Broadcast()
	l.mu.Unlock()
	if held {
		<-l.q.slot
	}
}
