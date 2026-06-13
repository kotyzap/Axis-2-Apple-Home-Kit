import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    Accessory,
    AudioStreamingCodecType,
    AudioStreamingSamplerate,
    Categories,
    CameraController,
    CameraStreamingDelegate,
    Characteristic,
    HAPStorage,
    PrepareStreamCallback,
    PrepareStreamRequest,
    Service,
    SnapshotRequest,
    SnapshotRequestCallback,
    SRTPCryptoSuites,
    StreamingRequest,
    StreamRequestCallback,
    H264Level,
    H264Profile,
    uuid,
} from 'hap-nodejs';
import { HttpServer } from 'camstreamerlib/HttpServer';
import { settingsSchema, TSettings } from './schema';
import { fetchSnapshot } from './snapshot';
import { FfmpegStreamingDelegate } from './stream';
import { MotionMonitor } from './motion';
import { log, setDebug } from './logger';
import { HOMEKIT_SETUP_ID } from './constants';
import { status, markSnapshotSent } from './status';
import { fetchDeviceInfo, DeviceInfo } from './device';

let motionMonitor: MotionMonitor | undefined;

let streamingDelegate: FfmpegStreamingDelegate | undefined;

const PERSISTENT_DATA_PATH = process.env.PERSISTENT_DATA_PATH ?? './localdata/';

function loadSettings(): TSettings {
    try {
        const raw = fs.readFileSync(path.join(PERSISTENT_DATA_PATH, 'settings.json'), 'utf8');
        return settingsSchema.parse(JSON.parse(raw));
    } catch (err) {
        console.warn('Settings missing/invalid, using defaults:', err);
        return settingsSchema.parse({ camera: {}, homekit: {} });
    }
}

// Stable, persisted HAP "MAC" so the accessory identity survives restarts.
function getHapUsername(): string {
    const idFile = path.join(PERSISTENT_DATA_PATH, 'hap_username.txt');
    try {
        const v = fs.readFileSync(idFile, 'utf8').trim();
        if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(v)) return v;
    } catch {
        /* first run */
    }
    const b = crypto.randomBytes(6);
    b[0] = (b[0] & 0xfe) | 0x02; // locally administered, unicast
    const mac = [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
    fs.writeFileSync(idFile, mac);
    return mac;
}

class SnapshotOnlyDelegate implements CameraStreamingDelegate {
    constructor(private settings: TSettings) {}

    async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
        const t0 = Date.now();
        log.debug(`Snapshot requested: ${request.width}x${request.height}`);
        try {
            const jpeg = await fetchSnapshot(this.settings);
            log.debug(`Snapshot OK: ${jpeg.length} bytes in ${Date.now() - t0} ms`);
            markSnapshotSent();
            callback(undefined, jpeg);
        } catch (err) {
            log.error(`Snapshot FAILED after ${Date.now() - t0} ms:`, (err as Error).message);
            callback(err as Error);
        }
    }

    // Phase 2: SRTP live stream. For the snapshot-first MVP we decline stream setup;
    // the Home app tile still shows live-updating snapshots.
    prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
        callback(new Error('Live streaming not implemented yet (snapshot-only MVP)'));
    }

    handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
        callback(new Error('Live streaming not implemented yet (snapshot-only MVP)'));
    }
}

// Expose progress to the settings UI. Reachable from index.js through the
// CamScripter authenticated proxy: /local/camscripter/proxy/<pkg>/status.cgi
// Best-effort: if HttpServer can't bind (e.g. local dev without HTTP_PORT),
// the app still runs — the UI just falls back to optimistic progress.
function startStatusServer(): void {
    try {
        const server = new HttpServer();
        server.onRequest('/status.cgi', (_req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(status));
        });
        log.info('Status server ready (/status.cgi)');
    } catch (err) {
        log.warn('Status server not started:', (err as Error).message);
    }
}

async function start(): Promise<void> {
    const settings = loadSettings();
    setDebug(settings.homekit.debug);
    startStatusServer();

    status.configured = settings.camera.user.length > 0;

    if (settings.camera.user.length === 0) {
        console.log('Not configured (camera credentials empty) — open the settings UI. Idling.');
        // Keep the process alive — saving settings sends SIGINT and CamScripter
        // restarts us with valid config. Exiting here would cause a restart loop.
        setInterval(() => {}, 1 << 30);
        return;
    }

    // Pull the camera's real model/firmware so the Home app shows accurate info.
    const deviceInfo = await fetchDeviceInfo(settings);
    publishAccessory(settings, deviceInfo);
}

function publishAccessory(settings: TSettings, deviceInfo: DeviceInfo): void {
    const hapDir = path.join(PERSISTENT_DATA_PATH, 'hap');
    fs.mkdirSync(hapDir, { recursive: true });
    HAPStorage.setCustomStoragePath(hapDir);

    const accessory = new Accessory(settings.homekit.name, uuid.generate('fourxs_apple_home_kit.' + getHapUsername()));
    accessory
        .getService(Service.AccessoryInformation)!
        .setCharacteristic(Characteristic.Manufacturer, 'Axis Communications')
        .setCharacteristic(Characteristic.Model, deviceInfo.model ?? 'Axis Camera')
        .setCharacteristic(Characteristic.SerialNumber, deviceInfo.serial ?? getHapUsername())
        .setCharacteristic(Characteristic.FirmwareRevision, deviceInfo.firmware ?? '1.0');

    let delegate: CameraStreamingDelegate;
    if (settings.homekit.live_stream) {
        streamingDelegate = new FfmpegStreamingDelegate(settings);
        delegate = streamingDelegate;
        console.log('Live streaming enabled (ffmpeg SRTP, -c:v copy)');
    } else {
        delegate = new SnapshotOnlyDelegate(settings);
        console.log('Snapshot-only mode');
    }
    const controller = new CameraController({
        cameraStreamCount: 1,
        delegate,
        streamingOptions: {
            supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
            video: {
                codec: {
                    profiles: [H264Profile.MAIN],
                    levels: [H264Level.LEVEL4_0],
                },
                resolutions: [
                    [1920, 1080, 30],
                    [1280, 720, 30],
                    [640, 360, 30],
                ],
            },
            // iOS requires an advertised audio configuration even for video-only
            // cameras — without it the stream negotiation never starts and the
            // tile shows "Camera is not responding".
            audio: {
                twoWayAudio: false,
                codecs: [
                    {
                        type: AudioStreamingCodecType.OPUS,
                        samplerate: AudioStreamingSamplerate.KHZ_16,
                    },
                    {
                        type: AudioStreamingCodecType.OPUS,
                        samplerate: AudioStreamingSamplerate.KHZ_24,
                    },
                ],
            },
        },
    });
    accessory.configureController(controller);

    if (settings.homekit.motion_vmd || settings.homekit.motion_aoa) {
        // Separate Motion Sensor per detector so HomeKit shows independent
        // tiles, notifications, and automation triggers for VMD vs. AOA. HAP
        // requires a unique subtype to host two services of the same type.
        const services: Record<string, Service> = {};
        if (settings.homekit.motion_vmd) {
            const vmd = new Service.MotionSensor('VMD Motion Sensor', 'vmd');
            // The Home app ignores the service Name for additional same-type
            // services and falls back to "Motion Sensor" / "Motion Sensor 2".
            // ConfiguredName is what it actually displays (and lets the user
            // rename it later), so set it explicitly on each sensor.
            vmd.addOptionalCharacteristic(Characteristic.ConfiguredName);
            vmd.setCharacteristic(Characteristic.ConfiguredName, 'VMD Motion Sensor');
            accessory.addService(vmd);
            services.VMD = vmd;
        }
        if (settings.homekit.motion_aoa) {
            const aoa = new Service.MotionSensor('AOA Motion Sensor', 'aoa');
            aoa.addOptionalCharacteristic(Characteristic.ConfiguredName);
            aoa.setCharacteristic(Characteristic.ConfiguredName, 'AOA Motion Sensor');
            accessory.addService(aoa);
            services.AOA = aoa;
        }
        motionMonitor = new MotionMonitor(settings, (active, source) => {
            log.info(`Motion ${active ? 'DETECTED' : 'cleared'} (${source})`);
            services[source]?.updateCharacteristic(Characteristic.MotionDetected, active);
        });
        motionMonitor.start();
    }

    accessory.publish({
        username: getHapUsername(),
        pincode: settings.homekit.pincode,
        port: settings.homekit.port,
        category: Categories.IP_CAMERA,
        setupID: HOMEKIT_SETUP_ID,
        addIdentifyingMaterial: true,
    });

    accessory.on('identify' as Parameters<typeof accessory.on>[0], () => {
        log.info('HomeKit IDENTIFY received (user tapped Identify during pairing)');
    });
    accessory.on('advertised' as Parameters<typeof accessory.on>[0], () => {
        status.published = true;
        log.info('mDNS advertisement active — accessory is discoverable');
    });
    accessory.on('paired' as Parameters<typeof accessory.on>[0], () => {
        status.paired = true;
        log.info('Controller PAIRED successfully');
    });
    accessory.on('unpaired' as Parameters<typeof accessory.on>[0], () => {
        status.paired = false;
        log.info('Controller UNPAIRED — pairing state reset');
    });

    // Published now (advertised may not re-fire on a restart that's already paired).
    status.published = true;
    // Reflect persisted pairing state on startup (hap-nodejs keeps it across restarts).
    try {
        const info = (accessory as unknown as { _accessoryInfo?: { paired?: () => boolean } })._accessoryInfo;
        if (info?.paired?.()) {
            status.paired = true;
        }
    } catch {
        /* private API absent — rely on the paired event */
    }

    log.info(`HomeKit accessory "${settings.homekit.name}" published on port ${settings.homekit.port}`);
    log.info(`HAP username (MAC): ${getHapUsername()}, debug=${settings.homekit.debug}`);
    log.info(`Pairing PIN: ${settings.homekit.pincode}`);
    log.info(`Add it in the Home app: + > Add Accessory > More options > ${settings.homekit.name}`);
}

process.on('SIGINT', () => {
    console.log('SIGINT — exiting, CamScripter will restart us with new settings.');
    streamingDelegate?.stopAll();
    motionMonitor?.stop();
    process.exit(0);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
});

start().catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
});
