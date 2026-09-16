/**
 * Hardware Detection Service
 * 
 * Detects available hardware acceleration capabilities:
 * - NVIDIA GPU (NVENC/NVDEC via nvidia-smi)
 * - VAAPI (Linux integrated GPU acceleration)
 * - QuickSync (Intel GPU acceleration)
 * 
 * Results are cached at startup and exposed via API.
 */

const { execSync, exec, spawn } = require('child_process');
const os = require('os');

// Cache detection results
let hwCapabilities = null;

/**
 * NVIDIA GPU compute capability requirements for codec support
 * Source: https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new
 */
const NVDEC_MIN_COMPUTE = {
    h264: 3.0,   // Kepler+
    hevc: 5.0,   // Maxwell GM206+
    av1: 8.0,    // Ada Lovelace+
};

/**
 * Encode five frames of a test pattern and see whether it actually works.
 *
 * A render node existing says nothing about whether the driver can encode with it.
 * On new AMD parts a broken Mesa VPE path gives a black screen and a log full of
 * "SIVPE ERROR" while every device check passes, so the encoder has to be tried
 * rather than inferred. Costs about a second, once, at startup.
 */
function verifyEncoder(encoder, device, ffmpegPath = 'ffmpeg') {
    const common = ['-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-frames:v', '5'];

    const perEncoder = {
        vaapi: ['-vaapi_device', device || '/dev/dri/renderD128',
            '-vf', 'format=nv12,hwupload,scale_vaapi=w=-2:h=360:format=nv12',
            '-c:v', 'h264_vaapi'],
        nvenc: ['-c:v', 'h264_nvenc'],
        qsv: ['-c:v', 'h264_qsv'],
        amf: ['-c:v', 'h264_amf']
    };
    if (!perEncoder[encoder]) return Promise.resolve(true);

    return new Promise(resolve => {
        const args = [...common, ...perEncoder[encoder], '-f', 'null', '-'];
        let stderr = '';
        let proc;
        try {
            proc = spawn(ffmpegPath, args);
        } catch (err) {
            return resolve(false);
        }
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(false); }, 15000);
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', () => { clearTimeout(timer); resolve(false); });
        proc.on('close', code => {
            clearTimeout(timer);
            // Some drivers report success and still spew errors for every frame.
            const ok = code === 0 && !/SIVPE ERROR|No VA display|Failed to (initialise|create)/i.test(stderr);
            if (!ok) {
                console.log(`[HwDetect] ${encoder} failed a test encode: ${(stderr.trim().split('\n')[0] || `exit ${code}`)}`);
            }
            resolve(ok);
        });
    });
}

/**
 * Detect NVIDIA GPU and its capabilities
 */
async function detectNvidia() {
    try {
        // Query GPU info via nvidia-smi
        const result = execSync(
            'nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader',
            { timeout: 5000, encoding: 'utf-8', windowsHide: true }
        );

        const lines = result.trim().split('\n');
        if (lines.length === 0 || !lines[0]) {
            return { available: false };
        }

        // Parse "NVIDIA GeForce RTX 3080, 8.6"
        const parts = lines[0].split(',');
        if (parts.length < 2) {
            return { available: false };
        }

        const gpuName = parts[0].trim();
        const computeCap = parseFloat(parts[1].trim());

        // Determine supported codecs based on compute capability
        const supportedCodecs = [];
        for (const [codec, minCap] of Object.entries(NVDEC_MIN_COMPUTE)) {
            if (computeCap >= minCap) {
                supportedCodecs.push(codec);
            }
        }

        console.log(`[HwDetect] NVIDIA GPU detected: ${gpuName} (compute ${computeCap})`);
        console.log(`[HwDetect] NVDEC supported codecs: ${supportedCodecs.join(', ')}`);

        return {
            available: true,
            name: gpuName,
            computeCap,
            supportedCodecs,
            encoder: 'h264_nvenc',
            decoder: 'h264_cuvid'
        };
    } catch (err) {
        // nvidia-smi not found or no GPU
        console.log('[HwDetect] No NVIDIA GPU detected');
        return { available: false };
    }
}

/**
 * Detect VAAPI support (Linux only)
 * Checks for /dev/dri/renderD* devices
 */
async function detectVAAPI() {
    if (os.platform() !== 'linux') {
        return { available: false, reason: 'VAAPI is Linux-only' };
    }

    try {
        // Check for render nodes
        const result = execSync('ls /dev/dri/renderD* 2>/dev/null', {
            timeout: 2000,
            encoding: 'utf-8',
            shell: true
        });

        const devices = result.trim().split('\n').filter(d => d);
        if (devices.length === 0) {
            return { available: false, reason: 'No render devices found' };
        }

        // Use first available device
        const device = devices[0];
        console.log(`[HwDetect] VAAPI device found: ${device}`);

        return {
            available: true,
            device,
            encoder: 'h264_vaapi',
            decoder: 'vaapi'
        };
    } catch (err) {
        console.log('[HwDetect] VAAPI not available');
        return { available: false };
    }
}

/**
 * Detect Intel QuickSync support
 * Checks if FFmpeg can use QSV
 */
async function detectQuickSync() {
    try {
        // Check if Intel GPU exists
        let hasIntelGpu = false;

        if (os.platform() === 'win32') {
            // Windows: Check via WMIC
            const result = execSync(
                'wmic path win32_VideoController get name',
                { timeout: 5000, encoding: 'utf-8', windowsHide: true }
            );
            hasIntelGpu = result.toLowerCase().includes('intel');
        } else if (os.platform() === 'linux') {
            // Linux: Check lspci
            try {
                const result = execSync('lspci | grep -i "vga\\|display" | grep -i intel', {
                    timeout: 5000,
                    encoding: 'utf-8',
                    shell: true
                });
                hasIntelGpu = result.trim().length > 0;
            } catch {
                hasIntelGpu = false;
            }
        }

        if (!hasIntelGpu) {
            return { available: false, reason: 'No Intel GPU found' };
        }

        console.log('[HwDetect] Intel GPU detected, QSV may be available');

        return {
            available: true,
            encoder: 'h264_qsv',
            decoder: 'h264_qsv'
        };
    } catch (err) {
        console.log('[HwDetect] QuickSync not available');
        return { available: false };
    }
}

/**
 * Detect AMD AMF support (Windows only)
 * Linux AMD uses VAAPI (detected separately)
 */
async function detectAMF() {
    if (os.platform() !== 'win32') {
        // On Linux, AMD GPUs use VAAPI which is detected separately
        return { available: false, reason: 'AMF is Windows-only (Linux uses VAAPI)' };
    }

    try {
        // Windows: Check via WMIC for AMD/Radeon
        const result = execSync(
            'wmic path win32_VideoController get name',
            { timeout: 5000, encoding: 'utf-8', windowsHide: true }
        );

        const lowerResult = result.toLowerCase();
        const hasAmdGpu = lowerResult.includes('amd') || lowerResult.includes('radeon');

        if (!hasAmdGpu) {
            return { available: false, reason: 'No AMD GPU found' };
        }

        // Extract GPU name for display
        const lines = result.trim().split('\n').filter(l => l.trim());
        let gpuName = 'AMD GPU';
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().includes('amd') || trimmed.toLowerCase().includes('radeon')) {
                gpuName = trimmed;
                break;
            }
        }

        console.log(`[HwDetect] AMD GPU detected: ${gpuName}`);

        return {
            available: true,
            name: gpuName,
            encoder: 'h264_amf',
            decoder: 'h264'  // AMF has limited decode support, often uses software
        };
    } catch (err) {
        console.log('[HwDetect] AMF not available');
        return { available: false };
    }
}

/**
 * Detect all hardware capabilities
 * Results are cached for performance
 */
async function detect() {
    if (hwCapabilities !== null) {
        return hwCapabilities;
    }

    console.log('[HwDetect] Probing hardware acceleration capabilities...');

    const [nvidia, vaapi, qsv, amf] = await Promise.all([
        detectNvidia(),
        detectVAAPI(),
        detectQuickSync(),
        detectAMF()
    ]);

    // Recommend the first candidate that is present AND actually encodes.
    // Priority: NVENC > AMF > QSV > VAAPI > Software.
    const candidates = [
        ['nvenc', nvidia.available, null],
        ['amf', amf.available, null],
        ['qsv', qsv.available, null],
        ['vaapi', vaapi.available, vaapi.device]
    ];

    let recommended = 'software';
    for (const [name, present, device] of candidates) {
        if (!present) continue;
        if (await verifyEncoder(name, device)) {
            recommended = name;
            break;
        }
        console.log(`[HwDetect] ${name} is present but cannot encode - skipping it`);
    }

    hwCapabilities = {
        nvidia,
        amf,
        vaapi,
        qsv,
        recommended,
        platform: os.platform(),
        detectedAt: new Date().toISOString()
    };

    console.log(`[HwDetect] Recommended encoder: ${recommended}`);

    return hwCapabilities;
}

/**
 * Get cached capabilities (or detect if not cached)
 */
function getCapabilities() {
    return hwCapabilities;
}

/**
 * Force re-detection (clears cache)
 */
async function refresh() {
    hwCapabilities = null;
    return detect();
}

module.exports = {
    detect,
    verifyEncoder,
    getCapabilities,
    refresh,
    detectNvidia,
    detectAMF,
    detectVAAPI,
    detectQuickSync
};
