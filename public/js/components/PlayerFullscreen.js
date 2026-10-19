/** Invoke fullscreen synchronously within the click/keyboard gesture, then handle its promise. */
const PlayerFullscreen = {
    async toggle(video, container, doc = document) {
        try {
            if (doc.fullscreenElement && doc.exitFullscreen) {
                await doc.exitFullscreen();
            } else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) {
                await doc.webkitExitFullscreen();
            } else if (video?.webkitDisplayingFullscreen && video.webkitExitFullscreen) {
                await video.webkitExitFullscreen();
            } else {
                const target = container || video;
                // Some iPhones expose element methods even though element fullscreen is disabled.
                const standard = doc.fullscreenEnabled === true ||
                    (doc.fullscreenEnabled === undefined && !video?.webkitEnterFullscreen);
                const prefixed = doc.webkitFullscreenEnabled === true ||
                    (doc.webkitFullscreenEnabled === undefined && doc.fullscreenEnabled !== false && !video?.webkitEnterFullscreen);
                if (standard && target?.requestFullscreen) await target.requestFullscreen();
                else if (prefixed && target?.webkitRequestFullscreen) await target.webkitRequestFullscreen();
                else if (video?.webkitEnterFullscreen) await video.webkitEnterFullscreen();
                else return false;
            }
            return true;
        } catch (error) {
            console.error('Fullscreen failed:', error.message);
            return false;
        }
    }
};
if (typeof window !== 'undefined') window.PlayerFullscreen = PlayerFullscreen;
if (typeof module !== 'undefined') module.exports = PlayerFullscreen;
