import { z } from 'zod';

export const settingsSchema = z.object({
    camera: z.object({
        protocol: z.enum(['http', 'https']).default('http'),
        ip: z.string().default('127.0.0.1'),
        port: z.number().default(80),
        user: z.string().default(''),
        pass: z.string().default(''),
    }),
    homekit: z.object({
        name: z.string().default('Axis Camera'),
        pincode: z
            .string()
            .regex(/^\d{3}-\d{2}-\d{3}$/)
            .default('031-45-154'),
        port: z.number().default(51826),
        snapshot_resolution: z.string().default('1920x1080'),
        live_stream: z.boolean().default(true),
        stream_resolution: z.string().default('1920x1080'),
        stream_fps: z.number().min(1).max(60).default(30),
        audio_enabled: z.boolean().default(true),
        video_mode: z.enum(['copy', 'transcode']).default('copy'),
        motion_vmd: z.boolean().default(true),
        motion_aoa: z.boolean().default(true),
        // Keep MotionDetected = true for at least this many seconds after the
        // last "active" event. Debounces VMD4/AOA flapping so the Home app
        // doesn't fire a burst of notifications. 0 = report state as-is.
        motion_hold_s: z.number().min(0).max(300).default(5),
        stream_bitrate_kbps: z.number().min(0).default(0), // 0 = camera default
        debug: z.boolean().default(false),
        supporter: z.boolean().default(false),
    }),
});

export type TSettings = z.infer<typeof settingsSchema>;
