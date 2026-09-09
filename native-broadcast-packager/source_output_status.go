package main

type sourceChangingOutput interface {
	OutputState() (sourceHLSEpoch, bool)
	StateChanges() <-chan struct{}
}

// Bounded change notifications are hints, never source/membership authority.
// An epoch change also detects an interruption coalesced while status IO waited.
func (o *sourceAssignmentOwner) observeChangingOutput(p *sourceProgramGeneration, output sourceChangingOutput) {
	var epoch sourceHLSEpoch
	ready := false
	for {
		if !o.permitted() {
			return
		}
		nextEpoch, nextReady := output.OutputState()
		if ready && (!nextReady || epoch != nextEpoch) {
			if err := o.transition("degraded", "SOURCE_PROGRAM_RESTARTING"); err != nil {
				o.cancel()
				return
			}
			ready = false
		}
		if nextReady && !ready {
			if err := o.transition("running", "OUTPUT_READY"); err != nil {
				o.cancel()
				return
			}
		}
		epoch, ready = nextEpoch, nextReady
		select {
		case <-o.done:
			return
		case <-p.finished:
			return
		case <-output.StateChanges():
		}
	}
}
