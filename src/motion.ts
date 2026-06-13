import { VapixEvents } from 'camstreamerlib/VapixEvents';
import { TSettings } from './schema';
import { log } from './logger';

type MotionCallback = (active: boolean, source: string) => void;

// Per-source debounce state so VMD and AOA can drive independent HomeKit
// Motion Sensors without one detector's events clobbering the other's.
type SourceState = {
    current: boolean;
    holdTimer: ReturnType<typeof setTimeout> | null;
    resetTimer: ReturnType<typeof setTimeout> | null;
};

// Listens to the camera's own VAPIX event stream and reports motion from
// AXIS Video Motion Detection (VMD4) and/or AXIS Object Analytics (AOA).
export class MotionMonitor {
    private events?: VapixEvents;
    private states = new Map<string, SourceState>();

    constructor(
        private settings: TSettings,
        private onMotion: MotionCallback
    ) {}

    start(): void {
        const cam = this.settings.camera;
        const hk = this.settings.homekit;
        if (!hk.motion_vmd && !hk.motion_aoa) {
            log.info('Motion sensor: no sources enabled');
            return;
        }

        this.events = new VapixEvents({
            ip: cam.ip,
            port: cam.port,
            user: cam.user,
            pass: cam.pass,
            tls: cam.protocol === 'https',
        });

        // VapixEvents uses registered listener names as VAPIX topic filters and
        // re-emits each event under its full topic name. Register a broad
        // RuleEngine filter for the subscription, then catch everything via onAny.
        this.events.on('tns1:RuleEngine//.', () => {
            /* subscription anchor — real handling in onAny */
        });

        this.events.onAny((eventName, msg) => {
            const topic = String(eventName);
            if (topic === 'open' || topic === 'close' || topic === 'error') {
                return;
            }
            const notification = (msg as { params?: { notification?: { topic?: string; message?: { data?: Record<string, string> } } } })
                ?.params?.notification;
            const isVmd = hk.motion_vmd && /VideoMotionDetection|VMD/i.test(topic);
            const isAoa = hk.motion_aoa && /ObjectAnalytics/i.test(topic);
            log.debug(`VAPIX event: topic=${topic} data=${JSON.stringify(notification?.message?.data ?? {})}`);
            if (!isVmd && !isAoa) {
                return;
            }
            const active = this.extractActive(notification?.message?.data);
            const source = isVmd ? 'VMD' : 'AOA';
            if (active === undefined) {
                return;
            }
            this.report(active, source);
        });

        this.events.on('error', (err: Error) => {
            log.error('VapixEvents error:', err.message);
        });

        this.events.connect();
        log.info(
            `Motion sensor: listening for ${[hk.motion_vmd ? 'VMD' : '', hk.motion_aoa ? 'AOA' : '']
                .filter(Boolean)
                .join(' + ')} events`
        );
    }

    // Event payload shapes vary by source/firmware — look for the usual flags.
    private extractActive(data: unknown): boolean | undefined {
        if (data === null || typeof data !== 'object') {
            return undefined;
        }
        const obj = data as Record<string, unknown>;
        for (const key of ['active', 'state', 'motion', 'running']) {
            if (key in obj) {
                const v = obj[key];
                return v === true || v === '1' || v === 1 || v === 'true';
            }
        }
        return undefined;
    }

    private getState(source: string): SourceState {
        let s = this.states.get(source);
        if (!s) {
            s = { current: false, holdTimer: null, resetTimer: null };
            this.states.set(source, s);
        }
        return s;
    }

    private report(active: boolean, source: string): void {
        const holdMs = (this.settings.homekit.motion_hold_s ?? 0) * 1000;
        const s = this.getState(source);

        if (active) {
            // Motion (re)started: cancel any pending clear so a flapping detector
            // stays "detected" instead of toggling HomeKit on/off repeatedly.
            if (s.holdTimer) {
                clearTimeout(s.holdTimer);
                s.holdTimer = null;
            }
            if (!s.current) {
                s.current = true;
                this.onMotion(true, source);
            }
            // Safety net: clear motion if the camera never sends the inactive event.
            if (s.resetTimer) {
                clearTimeout(s.resetTimer);
            }
            s.resetTimer = setTimeout(() => {
                log.debug(`Motion auto-reset (${source}: no inactive event within 60 s)`);
                this.clear(source);
            }, 60000);
            return;
        }

        // Inactive event: clear immediately, or after the hold window so brief
        // gaps between consecutive detections don't fire extra notifications.
        if (holdMs > 0) {
            if (s.holdTimer) {
                clearTimeout(s.holdTimer);
            }
            s.holdTimer = setTimeout(() => this.clear(source), holdMs);
        } else {
            this.clear(source);
        }
    }

    private clear(source: string): void {
        const s = this.getState(source);
        if (s.holdTimer) {
            clearTimeout(s.holdTimer);
            s.holdTimer = null;
        }
        if (s.resetTimer) {
            clearTimeout(s.resetTimer);
            s.resetTimer = null;
        }
        if (s.current) {
            s.current = false;
            this.onMotion(false, source);
        }
    }

    stop(): void {
        for (const s of this.states.values()) {
            if (s.holdTimer) clearTimeout(s.holdTimer);
            if (s.resetTimer) clearTimeout(s.resetTimer);
        }
        this.states.clear();
        this.events?.disconnect();
    }
}
