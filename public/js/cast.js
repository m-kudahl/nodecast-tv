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

        // Nothing should be playing locally as well as on the TV.
        window.app?.player?.stop?.();
        await this.releaseSession();

        this.channel = channel;
        const url = await this.transcodeUrlFor(streamUrl);
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
    async transcodeUrlFor(streamUrl) {
        let info = {};
        try {
            info = await fetch(`/api/probe?url=${encodeURIComponent(streamUrl)}`).then(r => r.json());
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
                isLive: true,
                videoMode,
                videoCodec: info.video,
                audioCodec: info.audio,
                audioChannels: info.audioChannels,
                videoHeight: info.height
            })
        });
        if (!res.ok) throw new Error('Could not start a transcode session for casting');

        const { sessionId, playlistUrl } = await res.json();
        this.sessionId = sessionId;
        return (await this.castableOrigin()) + playlistUrl;
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
        if (!this.sessionId) return;
        const id = this.sessionId;
        this.sessionId = null;
        this.channel = null;
        try {
            await fetch(`/api/transcode/${id}`, { method: 'DELETE' });
        } catch (err) {
            console.warn('[Cast] Failed to stop transcode session:', err.message);
        }
    }
}

// The SDK calls this when it finishes loading; it only loads in Chrome, and only
// in a secure context (https, or http://localhost).
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
