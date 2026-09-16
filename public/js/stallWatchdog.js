/**
 * Stall Watchdog
 *
 * Both players wedge the same way: the buffer stalls, hls.js reports nothing fatal,
 * so nothing retries and the picture freezes until you switch stream and back.
 * Watching currentTime is the only reliable signal - the 'waiting'/'stalled' events
 * fire constantly on healthy streams and not at all on some wedges.
 */
class StallWatchdog {
    /**
     * @param {() => HTMLVideoElement|null} getVideo
     * @param {{kick: Function, recover: Function, reload: Function, isActive?: () => boolean}} steps
     */
    constructor(getVideo, steps) {
        this.getVideo = getVideo;
        this.steps = steps;
        this.timer = null;
        this.reset();
    }

    /**
     * Which recovery step a stall of `ms` warrants, given the last one already tried.
     * Pure so it can be tested without a DOM - see test_watchdog.js.
     */
    static action(ms, hidden, last) {
        const step = ms >= 16000 ? 'reload' : ms >= 10000 ? 'recover' : ms >= 4000 ? 'kick' : null;
        if (!step || step === last) return null;
        // A hidden tab is throttled by the browser on purpose - nudge it, but never
        // tear down and re-probe a stream nobody is looking at.
        if (hidden && step !== 'kick') return null;
        return step;
    }

    reset() {
        this.lastTime = -1;
        this.stalledMs = 0;
        this.lastAction = null;
    }

    start() {
        this.stop();
        this.reset();
        this.timer = setInterval(() => this.tick(), StallWatchdog.TICK);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    tick() {
        const v = this.getVideo();
        const active = this.steps.isActive ? this.steps.isActive() : true;

        if (!v || !active || v.paused || v.ended || v.seeking) {
            this.reset();
            this.lastTime = v ? v.currentTime : -1;
            return;
        }

        if (v.currentTime !== this.lastTime) {
            if (this.stalledMs) console.log('[Watchdog] playback resumed');
            this.lastTime = v.currentTime;
            this.stalledMs = 0;
            this.lastAction = null;
            return;
        }

        this.stalledMs += StallWatchdog.TICK;
        const action = StallWatchdog.action(this.stalledMs, document.hidden, this.lastAction);
        if (!action) return;

        console.warn(`[Watchdog] stalled ${this.stalledMs / 1000}s -> ${action}`);
        this.lastAction = action;

        if (action === 'reload') {
            // ponytail: fixed 16s retry cycle. Add backoff if dead streams turn out to
            // hammer the server's transcode sessions.
            this.reset();
        }
        this.steps[action]();
    }
}

StallWatchdog.TICK = 2000;

if (typeof window !== 'undefined') window.StallWatchdog = StallWatchdog;
if (typeof module !== 'undefined') module.exports = StallWatchdog;
