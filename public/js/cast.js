/**
 * Chromecast sender.
 *
 * Two things make casting different from local playback:
 *
 * 1. The Chromecast fetches the media itself, so it needs a URL that resolves on
 *    the LAN. 'localhost' would point the Chromecast at itself.
 * 2. It is far pickier about codecs than a browser - H.264 + AAC only on anything
 *    below a Chromecast Ultra. So casting always goes through a transcode session,
 *    which already emits exactly that in an HLS/TS wrapper.
 *
 * The sender API needs a secure context, and plain http on a LAN IP is not one,
 * so the page itself has to be opened on http://localhost:<port>. That is why the
 * media URL is rewritten rather than taken from location.origin.
 */
class CastController {
    constructor() {
        this.available = false;
        this.sdkReady = false;
        this.sdkFailure = null;     // set if the SDK loaded but refused (e.g. Media Router off)
        this.sessionId = null;      // our transcode session, not the cast session
        this.channel = null;
        this.generation = 0;        // bumped per castChannel(), so a slow superseded cast backs off
        this.button = document.getElementById('btn-cast');
        this.button?.addEventListener('click', () => this.toggle());
    }

    /** Called by the Cast SDK once it has loaded. */
    init() {
        const context = cast.framework.CastContext.getInstance();
        context.setOptions({
            receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        });

        const applyState = (state) => {
            this.available = state !== cast.framework.CastState.NO_DEVICES_AVAILABLE;
            this.button?.classList.toggle('active', this.isCasting);
            if (this.button) {
                this.button.title = this.available
                    ? 'Cast to a Chromecast'
                    : 'No Chromecast found on this network yet';
            }
        };
        context.addEventListener(
            cast.framework.CastContextEventType.CAST_STATE_CHANGED,
            (e) => applyState(e.castState)
        );
        // Discovery may already have finished before the listener was attached.
        applyState(context.getCastState());
        this.sdkReady = true;

        context.addEventListener(
            cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
            (e) => {
                if (e.sessionState === cast.framework.SessionState.SESSION_ENDED) {
                    console.log('[Cast] Session ended');
                    this.releaseSession();
                    this.button?.classList.remove('active');
                }
            }
        );

        console.log('[Cast] Sender ready');
    }

    get isCasting() {
        return !!window.cast?.framework?.CastContext.getInstance().getCurrentSession();
    }

    /** Why casting can't work in this browser, or null if it can. */
    get unavailableReason() {
        if (this.sdkReady) return null;
        if (!window.isSecureContext) {
            return `Casting only works when the app is opened on http://localhost:${location.port || 80} ` +
                '(or over https). Chrome refuses to start the Cast SDK on a plain-http LAN address.';
        }
        if (!window.chrome) {
            return 'Casting needs Google Chrome (or a Chromium browser with casting enabled). ' +
                'Firefox and Safari have no Chromecast support.';
        }
        if (this.sdkFailure) return this.sdkFailure;
        return 'The Google Cast SDK did not load - an ad/tracker blocker blocking www.gstatic.com, ' +
            'or no internet connection, will do that.';
    }

    async toggle() {
        const reason = this.unavailableReason;
        if (reason) {
            console.warn('[Cast]', reason);
            alert(reason);
            return;
        }
        if (this.isCasting) return this.stop();

        const player = window.app?.player;
        if (!player?.currentChannel) {
            alert('Start a channel first, then cast it.');
            return;
        }
        try {
            await cast.framework.CastContext.getInstance().requestSession();
        } catch (err) {
            if (err !== 'cancel') console.warn('[Cast] Could not connect:', err);
            return;
        }
        await this.castChannel(player.currentChannel, player.currentStreamUrl);
    }

    /**
     * Send a channel to the connected Chromecast. VideoPlayer.play() routes here
     * while a cast session is live, so picking a channel casts it.
     */
    async castChannel(channel, streamUrl) {
        const session = cast.framework.CastContext.getInstance().getCurrentSession();
        if (!session) return;
        const generation = ++this.generation;
        const player = window.app?.player;

        // Nothing should be playing locally as well as on the TV.
        player?.stop?.();
        await this.releaseSession();

        try {
            // Enigma2/OpenWebif receivers have to be tuned before their stream carries the channel.
            await player?.zapBeforeStreaming?.(channel, streamUrl);
            if (generation !== this.generation) return;

            const { sessionId, url } = await this.transcodeUrlFor(channel, streamUrl);
            // A newer cast won the race: drop this session rather than adopt it.
            if (generation !== this.generation) return this.deleteSession(sessionId);
            this.sessionId = sessionId;
            this.channel = channel;
            await this.load(session, channel, url);
        } catch (err) {
            if (generation !== this.generation) return;
            console.error('[Cast] Could not cast channel:', err);
            await this.releaseSession();
            // chrome.cast.Error carries a description rather than a message
            alert(`Could not cast ${channel.name || 'this channel'}: ${err.message || err.description || err.code || err}`);
        }
    }

    async load(session, channel, url) {
        console.log('[Cast] Loading', url);

        const media = new chrome.cast.media.MediaInfo(url, 'application/x-mpegurl');
        media.streamType = chrome.cast.media.StreamType.LIVE;
        // The session muxes MPEG-TS segments; say so rather than let the receiver guess.
        if (chrome.cast.media.HlsSegmentFormat) media.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS;
        if (chrome.cast.media.HlsVideoSegmentFormat) media.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS;
        media.metadata = new chrome.cast.media.GenericMediaMetadata();
        media.metadata.title = channel.name || 'Live TV';
        if (channel.tvgLogo) media.metadata.images = [new chrome.cast.Image(channel.tvgLogo)];

        await session.loadMedia(new chrome.cast.media.LoadRequest(media));
        this.button?.classList.add('active');
        window.app?.player?.updateNowPlaying?.(channel);
    }

    /**
     * Start a transcode session for this stream and return its playlist as an
     * absolute URL the Chromecast can actually reach.
     */
    async transcodeUrlFor(channel, streamUrl) {
        const program = channel.program ?? null; // MPEG-TS program, for multi-program (Enigma2) streams
        let info = {};
        try {
            const query = `url=${encodeURIComponent(streamUrl)}` + (program == null ? '' : `&program=${encodeURIComponent(program)}`);
            info = await fetch(`/api/probe?${query}`).then(r => r.json());
        } catch (err) {
            console.warn('[Cast] Probe failed, assuming the video needs encoding:', err.message);
        }

        // Chromecast below Ultra decodes H.264 only, so anything else must be encoded.
        const videoMode = info.video?.includes('h264') ? 'copy' : 'encode';
        const res = await fetch('/api/transcode/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: streamUrl,
                cast: true,
                isLive: true,
                program,
                videoMode,
                videoCodec: info.video,
                audioCodec: info.audio,
                audioChannels: info.audioChannels,
                videoHeight: info.height
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.castUrl) {
            throw new Error(body.reason || body.error || 'the server could not start a transcode session');
        }
        try {
            return { sessionId: body.sessionId, url: (await this.castableOrigin()) + body.castUrl };
        } catch (err) {
            await this.deleteSession(body.sessionId);
            throw err;
        }
    }

    /**
     * An address the Chromecast can reach. Whatever host the user typed already
     * routes - unless it is localhost, which on the Chromecast means the Chromecast.
     */
    async castableOrigin() {
        const host = location.hostname;
        if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return location.origin;

        const { addresses, port } = await fetch('/api/cast/host').then(r => r.json());
        if (!addresses.length) {
            throw new Error('No LAN address found for this machine - the Chromecast has no way to reach it');
        }
        return `http://${addresses[0].address}:${port}`;
    }

    async stop() {
        cast.framework.CastContext.getInstance().endCurrentSession(true);
        await this.releaseSession();
        this.button?.classList.remove('active');
    }

    /** Tear down the transcode session we started, so ffmpeg stops pulling the stream. */
    async releaseSession() {
        const id = this.sessionId;
        this.sessionId = null;
        this.channel = null;
        if (id) await this.deleteSession(id);
    }

    async deleteSession(id) {
        try {
            await fetch(`/api/transcode/${id}`, { method: 'DELETE' });
        } catch (err) {
            console.warn('[Cast] Failed to stop transcode session:', err.message);
        }
    }
}

// The SDK only works in Chrome and only in a secure context (https, or
// http://localhost), so don't fetch Google's script anywhere it can't run.
CastController.SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
window.castController = new CastController();
window.__onGCastApiAvailable = function (isAvailable) {
    if (!isAvailable) {
        // Brave ships with its Media Router off; Chromium builds may lack it entirely.
        window.castController.sdkFailure = 'This browser has casting turned off. In Brave, enable ' +
            '"Media Router" under brave://settings/extensions and restart.';
        console.log('[Cast]', window.castController.sdkFailure);
        return;
    }
    window.castController.init();
};
if (window.chrome && window.isSecureContext) {
    // After __onGCastApiAvailable exists: the SDK calls it once loaded.
    const sdk = document.createElement('script');
    sdk.src = CastController.SDK_URL;
    sdk.async = true;
    document.head.appendChild(sdk);
}
