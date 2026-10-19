const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function fixture({ nodes = [], vendors = {}, inaccessible = [], pci = '', fail = false, platform = 'linux' } = {}) {
    const calls = [], filename = path.join(__dirname, '../server/services/hwDetect.js'), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console: { log() {} }, require: name => ({
        os: { platform: () => platform }, fs: { constants: fs.constants, readdirSync: () => nodes,
            accessSync: device => { if (inaccessible.includes(device)) throw Error('EACCES'); },
            readFileSync: file => { const name = file.split('/')[4]; if (!vendors[name]) throw Error('ENOENT'); return vendors[name]; } },
        child_process: { execSync: command => { calls.push({ command }); return pci; },
            execFile: (binary, args, options, callback) => { calls.push({ binary, args, options }); callback(fail ? Error('Encode unavailable or timeout') : null); } }
    })[name] }, { filename });
    return { hw: module.exports, calls };
}
test('QSV verifies a mapped Intel device with the configured FFmpeg and bounded H.264 encode', async () => {
    const f = fixture({ nodes: ['card0', 'renderD129', 'renderD128'], vendors: { renderD129: '0x8086\n', renderD128: '0x1002' } });
    const qsv = await f.hw.detectQuickSync('/configured/ffmpeg');
    assert.equal(qsv.available, true); assert.equal(qsv.device, '/dev/dri/renderD129');
    assert.equal(f.calls.length, 1); const call = f.calls[0];
    assert.equal(call.binary, '/configured/ffmpeg'); assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.windowsHide, true); assert.equal(call.options.maxBuffer, 262144);
    assert.ok(call.args.includes('qsv=probe:hw,child_device=/dev/dri/renderD129,child_device_type=vaapi'));
    assert.ok(call.args.includes('h264_qsv')); assert.ok(call.args.includes('format=nv12,hwupload=extra_hw_frames=16'));
});
test('QSV rejects unmapped, AMD, inaccessible and unusable Intel devices', async () => {
    for (const options of [{ pci: 'VGA Intel' }, { nodes: ['renderD128'], vendors: { renderD128: '0x1002' }, pci: 'VGA Intel' },
        { nodes: ['renderD128'], vendors: { renderD128: '0x8086' }, inaccessible: ['/dev/dri/renderD128'] },
        { nodes: ['renderD128'], vendors: { renderD128: '0x8086' }, fail: true },
        { nodes: ['renderD128', 'renderD129'], pci: 'VGA Intel' }]) {
        const f = fixture(options); assert.equal((await f.hw.detectQuickSync()).available, false);
        if (!options.fail) assert.equal(f.calls.filter(call => call.binary).length, 0);
    }
});
test('QSV handles a hidden sysfs vendor with PCI fallback and preserves Windows detection', async () => {
    const f = fixture({ nodes: ['renderD128'], pci: '00:02.0 VGA compatible controller: Intel Corporation UHD Graphics' });
    assert.equal((await f.hw.detectQuickSync()).available, true); assert.equal(f.calls[0].command, 'lspci');
    const noIntel = fixture({ nodes: ['renderD128'], pci: 'VGA AMD Radeon' }); assert.equal((await noIntel.hw.detectQuickSync()).available, false);
    const windows = fixture({ platform: 'win32', pci: 'Name\nIntel UHD Graphics' });
    assert.equal((await windows.hw.detectQuickSync()).available, true); assert.equal(windows.calls.length, 1);
});
test('QSV sessions use the detected render node and keep Windows or forced defaults', () => {
    const filename = path.join(__dirname, '../server/services/transcodeSession.js'), realRequire = createRequire(filename), module = { exports: {} };
    let device = '/dev/dri/renderD129';
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => name === './hwDetect' ? { getCapabilities: () => ({ qsv: { device } }) } : realRequire(name) }, { filename });
    const session = Object.create(module.exports.TranscodeSession.prototype), args = [];
    session.addHwAccelInputArgs(args, 'qsv');
    assert.ok(args.includes('qsv=nodecast:hw,child_device=/dev/dri/renderD129,child_device_type=vaapi'));
    assert.ok(args.includes('nodecast')); device = undefined;
    const defaults = []; session.addHwAccelInputArgs(defaults, 'qsv'); assert.deepEqual(defaults, ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv']);
});
