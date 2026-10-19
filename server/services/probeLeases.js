function cancelled() { return Object.assign(new Error('Playback probe was superseded'), { name: 'AbortError' }); }

function parseProbeLease(query) {
    if (query.probeLeaseId === undefined && query.requestSequence === undefined) return null;
    if (typeof query.probeLeaseId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(query.probeLeaseId) ||
        typeof query.requestSequence !== 'string' || !/^[1-9]\d{0,14}$/.test(query.requestSequence)) {
        throw new Error('Invalid probe lease or request sequence');
    }
    return { id: query.probeLeaseId, sequence: Number(query.requestSequence) };
}

function requestCancellation(req, res) {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    if (req.aborted || res.destroyed) controller.abort();
    return { signal: controller.signal, dispose: () => res.off('close', abort) };
}

class ProbeLeases {
    constructor() { this.entries = new Map(); }
    run(ownerId, lease, signal, task) {
        if (signal.aborted) return Promise.reject(cancelled());
        if (!lease) return task(signal);
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (!entry.job && now - entry.touched > 60000) this.entries.delete(key);
        }
        const key = JSON.stringify([ownerId, lease.id]);
        const previous = this.entries.get(key);
        if (previous && lease.sequence <= previous.sequence) return Promise.reject(cancelled());
        if (!previous && this.entries.size >= 1024) {
            const idle = Array.from(this.entries).find(([, entry]) => !entry.job);
            if (idle) this.entries.delete(idle[0]);
            else return Promise.reject(Object.assign(new Error('Too many active probes'), { code: 'PROBE_LIMIT' }));
        }
        const controller = new AbortController(), job = { controller };
        const entry = { sequence: lease.sequence, touched: now, job };
        this.entries.set(key, entry);
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        previous?.job?.controller.abort();
        // Wait for the previous process's close event, including when this request will use cached metadata.
        job.done = Promise.resolve().then(async () => {
            if (previous?.job) await previous.job.done.catch(() => {});
            if (controller.signal.aborted || this.entries.get(key) !== entry) throw cancelled();
            return task(controller.signal);
        }).finally(() => {
            signal.removeEventListener('abort', abort);
            if (this.entries.get(key) === entry) { entry.job = null; entry.touched = Date.now(); }
        });
        return job.done;
    }
}
module.exports = { ProbeLeases, parseProbeLease, requestCancellation, cancelled };
