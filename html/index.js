/* Settings UI plumbing — talks to CamScripter's settings proxy. */
const PKG = 'fourxs_apple_home_kit';
const BASE = `/local/camscripter/package/settings.cgi?package_name=${PKG}`;

const $ = (id) => document.getElementById(id);

// Must match HOMEKIT_SETUP_ID in src/constants.ts so the scanned QR matches
// the accessory the app actually advertises over mDNS.
const SETUP_ID = 'AXIS';
const HK_CATEGORY = 17; // Categories.IP_CAMERA

// HomeKit pincodes are 8 digits. Apple groups them 3-2-3 (031-45-154) and that
// is the form hap-nodejs/the backend require, but this UI displays/accepts them
// grouped 4-4 (0314-5154). Convert at the edges: 4-4 for display, 3-2-3 to store.
const pinDigits = (p) => String(p || '').replace(/\D/g, '');
const pinValid = (p) => pinDigits(p).length === 8;
function pinToDisplay(p) {
    const d = pinDigits(p);
    return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4)}` : (p || '');
}
function pinToStore(p) {
    const d = pinDigits(p);
    return d.length === 8 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : (p || '');
}

// Build the HomeKit setup payload URI (X-HM://...) — byte-for-byte equivalent
// to hap-nodejs Accessory.setupURI(), so the code we render is the same one
// the device would generate itself.
function homekitSetupURI(pin) {
    const code = parseInt(String(pin).replace(/\D/g, ''), 10);
    if (!Number.isFinite(code)) return null;
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    let valueLow = code | (1 << 28); // supports IP
    dv.setUint32(4, valueLow >>> 0);
    if (HK_CATEGORY & 1) buf[4] = buf[4] | (1 << 7);
    dv.setUint32(0, HK_CATEGORY >> 1);
    let payload = (dv.getUint32(4) + dv.getUint32(0) * 0x100000000).toString(36).toUpperCase();
    if (payload.length !== 9) {
        for (let i = 0; i <= 9 - payload.length; i++) payload = '0' + payload;
    }
    return 'X-HM://' + payload + SETUP_ID;
}

let qr = null;
function renderQR(pin) {
    if (typeof QRCode === 'undefined') return;
    const valid = pinValid(pin);
    $('qr_pin').textContent = pinToDisplay(pin);
    const box = $('qr');
    if (!valid) { box.innerHTML = ''; qr = null; return; }
    const uri = homekitSetupURI(pin);
    box.innerHTML = '';
    qr = new QRCode(box, { text: uri, width: 172, height: 172, correctLevel: QRCode.CorrectLevel.M });
}

// Theme switcher (light default per design preference)
const root = document.documentElement;
$('themeToggle').addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    $('themeToggle').textContent = next === 'light' ? '🌙 Dark' : '☀️ Light';
});

// Live-update the QR as the PIN is edited.
$('hk_pin').addEventListener('input', () => renderQR($('hk_pin').value));

async function load() {
    try {
        const res = await fetch(`${BASE}&action=get`);
        const s = await res.json();
        $('cam_user').value = s.camera?.user ?? '';
        $('cam_pass').value = s.camera?.pass ?? '';
        $('hk_name').value = s.homekit?.name ?? 'Axis Camera';
        $('hk_pin').value = pinToDisplay(s.homekit?.pincode ?? '031-45-154');
        $('hk_port').value = s.homekit?.port ?? 51826;
        $('hk_res').value = s.homekit?.snapshot_resolution ?? '1920x1080';
        $('hk_live').value = String(s.homekit?.live_stream ?? true);
        $('hk_stream_res').value = s.homekit?.stream_resolution ?? '1920x1080';
        $('hk_debug').value = String(s.homekit?.debug ?? false);
        $('hk_fps').value = String(s.homekit?.stream_fps ?? 30);
        $('hk_audio').value = String(s.homekit?.audio_enabled ?? true);
        $('hk_vmode').value = s.homekit?.video_mode ?? 'copy';
        $('hk_vmd').value = String(s.homekit?.motion_vmd ?? true);
        $('hk_aoa').value = String(s.homekit?.motion_aoa ?? true);
        $('hk_hold').value = s.homekit?.motion_hold_s ?? 5;
        $('hk_bitrate').value = s.homekit?.stream_bitrate_kbps ?? 0;
        updateGuide(s);
        await prefillDefaults(s);
    } catch (e) {
        $('status').textContent = 'Failed to load settings';
    }
}

$('save').addEventListener('click', async () => {
    const settings = {
        camera: {
            protocol: 'http',
            ip: '127.0.0.1',
            port: 80,
            user: $('cam_user').value,
            pass: $('cam_pass').value,
        },
        homekit: {
            name: $('hk_name').value,
            pincode: pinToStore($('hk_pin').value),
            port: parseInt($('hk_port').value, 10) || 51826,
            snapshot_resolution: $('hk_res').value,
            live_stream: $('hk_live').value === 'true',
            stream_resolution: $('hk_stream_res').value,
            debug: $('hk_debug').value === 'true',
            stream_fps: parseInt($('hk_fps').value, 10) || 30,
            audio_enabled: $('hk_audio').value === 'true',
            video_mode: $('hk_vmode').value,
            motion_vmd: $('hk_vmd').value === 'true',
            motion_aoa: $('hk_aoa').value === 'true',
            motion_hold_s: Math.max(0, Math.min(300, parseInt($('hk_hold').value, 10) || 0)),
            stream_bitrate_kbps: parseInt($('hk_bitrate').value, 10) || 0,
        },
    };
    if (!pinValid($('hk_pin').value)) {
        $('status').textContent = 'PIN must be XXXX-XXXX (8 digits)';
        return;
    }
    try {
        await fetch(`${BASE}&action=set`, { method: 'POST', body: JSON.stringify(settings) });
        $('status').textContent = 'Saved — app is restarting';
        updateGuide(settings);
    } catch (e) {
        $('status').textContent = 'Save failed';
    }
});

// First-run conveniences: prefill the accessory name from the camera's own
// model/name (VAPIX, same-origin browser session) and randomize the HAP port
// so multiple cameras in one home never collide on the default.
async function prefillDefaults(s) {
    const configured = (s.camera?.user ?? '').length > 0;
    if (configured) return; // don't touch a working setup

    // Random HAP port 51000–51999 (instead of the shared default 51826)
    if (!s.homekit?.port || s.homekit.port === 51826) {
        $('hk_port').value = 51000 + Math.floor(Math.random() * 1000);
    }

    // Camera model / device name
    if (!s.homekit?.name || s.homekit.name === 'Axis Camera' || s.homekit.name === 'Axis Q1656') {
        try {
            const res = await fetch('/axis-cgi/basicdeviceinfo.cgi', {
                method: 'POST',
                body: JSON.stringify({ apiVersion: '1.0', method: 'getProperties',
                    params: { propertyList: ['ProdShortName', 'ProdNbr'] } }),
            });
            const info = await res.json();
            const name = info?.data?.propertyList?.ProdShortName;
            if (name) { $('hk_name').value = name; return; }
        } catch (e) { /* fall through to param.cgi */ }
        try {
            const res = await fetch('/axis-cgi/param.cgi?action=list&group=Brand.ProdShortName');
            const text = await res.text(); // root.Brand.ProdShortName=AXIS M1137
            const m = text.match(/ProdShortName=(.+)/);
            if (m) $('hk_name').value = m[1].trim();
        } catch (e) { /* keep default */ }
    }
}

// --- Live progress ---------------------------------------------------------
// configured comes from saved settings; the rest is reported by the running app
// via /status.cgi (proxied by CamScripter). Falls back to optimistic progress
// if the status endpoint isn't reachable (older build / app still starting).
let configured = false;
const live = { published: false, paired: false, snapshotSent: false, reachable: false };

function updateGuide(s) {
    configured = (s.camera?.user ?? '').length > 0;
    const pin = pinToDisplay(s.homekit?.pincode ?? '031-45-154');
    $('guide_pin').textContent = pin;
    renderQR(pin);
    renderSteps();
}

function renderSteps() {
    const set = (id, cls) => { $(id).className = cls; };
    // If the app isn't reachable yet, assume publishing once credentials are set.
    const published = live.published || (configured && !live.reachable);
    const snap = live.snapshotSent;
    // A delivered snapshot implies the controller is paired.
    const paired = live.paired || snap;

    set('step1', configured ? 'done' : 'active');
    set('step2', published ? 'done' : (configured ? 'active' : ''));
    set('step3', paired ? 'done' : (published ? 'active' : ''));
    // Final step: orange ✓ once paired, green ✓ only after the first snapshot.
    set('step4', (paired && snap) ? 'done' : (paired ? 'active' : ''));

    let msg;
    if (!configured) {
        msg = 'Waiting for camera credentials — the app is idling until you Save.';
    } else if (paired && snap) {
        msg = 'Paired and streaming — first snapshot delivered. All set!';
    } else if (paired) {
        msg = 'Paired — waiting for the first snapshot to reach the Home app…';
    } else if (published) {
        msg = 'Accessory published — add it in the Home app (same Wi-Fi, mDNS/multicast allowed).';
    } else {
        msg = 'Credentials saved — publishing the accessory…';
    }
    $('guide_status').textContent = msg;
}

async function pollStatus() {
    try {
        const r = await fetch(`/local/camscripter/proxy/${PKG}/status.cgi`, { cache: 'no-store' });
        if (!r.ok) throw new Error('status ' + r.status);
        const st = await r.json();
        live.published = !!st.published;
        live.paired = !!st.paired;
        live.snapshotSent = !!st.snapshotSent;
        live.reachable = true;
    } catch (e) {
        live.reachable = false; // keep optimistic fallback
    }
    renderSteps();
}

load();
pollStatus();
setInterval(pollStatus, 4000);
