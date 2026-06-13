import { spawn, ChildProcess } from 'child_process';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    CameraController,
    CameraStreamingDelegate,
    PrepareStreamCallback,
    PrepareStreamRequest,
    PrepareStreamResponse,
    SnapshotRequest,
    SnapshotRequestCallback,
    StreamingRequest,
    StreamRequestCallback,
    StreamRequestTypes,
    StreamSessionIdentifier,
} from 'hap-nodejs';
import { TSettings } from './schema';
import { fetchSnapshot } from './snapshot';
import { log } from './logger';
import { markSnapshotSent } from './status';

type SessionInfo = {
    address: string; // iOS device address
    videoPort: number; // iOS device port
    localPort: number; // our bound UDP port (advertised in prepareStream response)
    localSocket: dgram.Socket;
    videoSrtpKey: Buffer;
    videoSrtpSalt: Buffer;
    videoSSRC: number;
    audioPort: number;
    audioLocalPort: number;
    audioLocalSocket: dgram.Socket;
    audioSrtpKey: Buffer;
    audioSrtpSalt: Buffer;
    audioSSRC: number;
};

// Phase 2: full SRTP live view.
// Pulls the camera's own H.264 RTSP stream (127.0.0.1, no transcoding: -c:v copy)
// and repackages it as SRTP to the iOS device using a static ARM64 ffmpeg binary
// bundled in bin/ffmpeg.
export class FfmpegStreamingDelegate implements CameraStreamingDelegate {
    private pending = new Map<string, SessionInfo>();
    private ongoing = new Map<string, { child: ChildProcess; socket: dgram.Socket }>();

    constructor(private settings: TSettings) {}

    // The camera has multiple addresses (real LAN IP + 169.254.x link-local).
    // hap-nodejs may advertise the link-local one, and Apple controllers DROP
    // all media whose source IP doesn't match the advertised address. Always
    // advertise the routable LAN address explicitly.
    private getLanAddress(version: 'ipv4' | 'ipv6'): string | undefined {
        const family = version === 'ipv6' ? 'IPv6' : 'IPv4';
        for (const ifaces of Object.values(os.networkInterfaces())) {
            for (const iface of ifaces ?? []) {
                if (iface.internal || iface.family !== family) continue;
                if (iface.address.startsWith('169.254.') || iface.address.startsWith('fe80')) continue;
                return iface.address;
            }
        }
        return undefined;
    }

    private get ffmpegPath(): string {
        // Pick the binary matching this camera's CPU:
        //   ARTPEC-8/9 = aarch64 (process.arch 'arm64'), ARTPEC-6/7 = armv7 ('arm').
        // CreatePackage flattens dist/ into the package root, so bin/ is a sibling
        // of this file on-camera, and one level up in local dev. Fall back to PATH.
        const archName = process.arch === 'arm' ? 'ffmpeg-armhf' : 'ffmpeg-arm64';
        const candidates = [
            path.join(__dirname, 'bin', archName),
            path.join(__dirname, '..', 'bin', archName),
            path.join(__dirname, 'bin', 'ffmpeg'),
            path.join(__dirname, '..', 'bin', 'ffmpeg'),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) {
                return c;
            }
        }
        return 'ffmpeg';
    }

    private get rtspUrl(): string {
        const cam = this.settings.camera;
        const auth = `${encodeURIComponent(cam.user)}:${encodeURIComponent(cam.pass)}`;
        const hk = this.settings.homekit;
        // videokeyframeinterval + fixed GOP: Zipstream's dynamic GOP can delay
        // keyframes for minutes on static scenes — iOS won't show video until
        // the first IDR arrives, leaving an endless spinner.
        let url =
            `rtsp://${auth}@${cam.ip}/axis-media/media.amp?videocodec=h264` +
            `&resolution=${hk.stream_resolution}&fps=${hk.stream_fps}` +
            `&videokeyframeinterval=${hk.stream_fps}&videozgopmode=fixed` +
            `&audio=${hk.audio_enabled ? 1 : 0}`;
        if (hk.stream_bitrate_kbps > 0) {
            url += `&videobitrate=${hk.stream_bitrate_kbps}`;
        }
        return url;
    }

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

    prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
        log.debug(
            `prepareStream: session=${request.sessionID} target=${request.targetAddress}:${request.video.port} ` +
                `suite=${request.video.srtpCryptoSuite} addressVersion=${request.addressVersion}`
        );
        const ssrc = CameraController.generateSynchronisationSource();
        const audioSSRC = CameraController.generateSynchronisationSource();

        // Bind a real local UDP port — HomeKit expects the port WE will send RTP
        // from / listen for RTCP on. Echoing the iOS port here breaks negotiation
        // on some setups ("camera not responding" on tap-to-stream).
        const type = request.addressVersion === 'ipv6' ? 'udp6' : 'udp4';
        const socket = dgram.createSocket(type);
        const audioSocket = dgram.createSocket(type);
        socket.on('error', (err) => log.error('UDP socket error:', err.message));
        audioSocket.on('error', (err) => log.error('UDP audio socket error:', err.message));
        socket.bind(0, () => {
            audioSocket.bind(0, () => {
                const localPort = socket.address().port;
                const audioLocalPort = audioSocket.address().port;
                const info: SessionInfo = {
                    address: request.targetAddress,
                    videoPort: request.video.port,
                    localPort,
                    localSocket: socket,
                    videoSrtpKey: request.video.srtp_key,
                    videoSrtpSalt: request.video.srtp_salt,
                    videoSSRC: ssrc,
                    audioPort: request.audio.port,
                    audioLocalPort,
                    audioLocalSocket: audioSocket,
                    audioSrtpKey: request.audio.srtp_key,
                    audioSrtpSalt: request.audio.srtp_salt,
                    audioSSRC,
                };
                this.pending.set(request.sessionID, info);

                // Audio is declared in streamingOptions (iOS requires it), so the
                // response MUST include an audio block with its OWN port.
                const lanAddress = this.getLanAddress(request.addressVersion);
                const response: PrepareStreamResponse = {
                    ...(lanAddress ? { addressOverride: lanAddress } : {}),
                    video: {
                        port: localPort,
                        ssrc,
                        srtp_key: request.video.srtp_key,
                        srtp_salt: request.video.srtp_salt,
                    },
                    audio: {
                        port: audioLocalPort,
                        ssrc: audioSSRC,
                        srtp_key: request.audio.srtp_key,
                        srtp_salt: request.audio.srtp_salt,
                    },
                };
                log.debug(
                    `prepareStream response: addressOverride=${lanAddress ?? 'none'} videoLocalPort=${localPort} audioLocalPort=${audioLocalPort} videoSSRC=${ssrc} audioSSRC=${audioSSRC}`
                );
                callback(undefined, response);
            });
        });
    }

    handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
        const sessionId: StreamSessionIdentifier = request.sessionID;
        log.debug(`handleStreamRequest: type=${request.type} session=${sessionId}`);

        switch (request.type) {
            case StreamRequestTypes.START: {
                const info = this.pending.get(sessionId);
                this.pending.delete(sessionId);
                if (!info) {
                    log.error('START for unknown session — prepareStream missing?');
                    callback(new Error('Unknown stream session'));
                    return;
                }

                log.info(`Live stream started: ${request.video.width}x${request.video.height}@${request.video.fps}fps`);
                log.debug(
                    `START detail: pt=${request.video.pt} maxBitrate=${request.video.max_bit_rate}kbps mtu=${request.video.mtu}`
                );

                const srtpParams = Buffer.concat([info.videoSrtpKey, info.videoSrtpSalt]).toString('base64');
                const audioSrtpParams = Buffer.concat([info.audioSrtpKey, info.audioSrtpSalt]).toString('base64');
                const mtu = request.video.mtu ?? 1316;
                const audioOn = this.settings.homekit.audio_enabled;

                const debug = this.settings.homekit.debug;
                const args = [
                    '-hide_banner',
                    '-loglevel', debug ? 'verbose' : 'warning',
                    ...(debug ? [] : ['-nostats']),
                    '-rtsp_transport', 'tcp',
                    '-timeout', '5000000', // µs — fail fast instead of hanging on RTSP open
                    '-i', this.rtspUrl,
                    // --- video: passthrough, zero transcoding on ARTPEC-8 ---
                    '-map', '0:v:0',
                    ...(this.settings.homekit.video_mode === 'transcode'
                        ? [
                              // Diagnostic/fallback: re-encode to a bitstream iOS provably
                              // accepts. Heavier on ARTPEC-8 CPU — keep resolution modest.
                              '-c:v', 'libx264',
                              '-preset', 'ultrafast',
                              '-tune', 'zerolatency',
                              '-pix_fmt', 'yuv420p',
                              '-profile:v', 'main',
                              '-level:v', '4.0',
                              '-s', `${request.video.width}x${request.video.height}`,
                              '-r', String(request.video.fps),
                              '-b:v', `${request.video.max_bit_rate}k`,
                              '-bufsize', `${2 * request.video.max_bit_rate}k`,
                              '-g', String(request.video.fps), // keyframe every second
                          ]
                        : [
                              '-c:v', 'copy',
                              // dump_extra: inject SPS/PPS in-band before keyframes (HomeKit
                              // has no SDP). h264_metadata: rewrite level to negotiated 4.0.
                              '-bsf:v', 'dump_extra,h264_metadata=level=4.0',
                          ]),
                    '-payload_type', String(request.video.pt),
                    '-ssrc', String(info.videoSSRC),
                    '-f', 'rtp',
                    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
                    '-srtp_out_params', srtpParams,
                    // RTP must ORIGINATE from the advertised port — Apple validates
                    // source IP:port and silently drops mismatched packets
                    // ("VCSDInfoIsSrcDstInfoMatchedWithIP IPPort mismatch").
                    `srtp://${info.address}:${info.videoPort}?rtcpport=${info.videoPort}&localrtpport=${info.localPort}&pkt_size=${mtu}`,
                ];

                if (audioOn) {
                    // --- audio: camera AAC → OPUS (HomeKit codec), mono, low delay ---
                    const sampleRate = (request.audio.sample_rate ?? 16) * 1000;
                    args.push(
                        '-map', '0:a:0?', // '?' = don't fail if the camera has no audio stream
                        '-c:a', 'libopus',
                        '-application', 'lowdelay',
                        '-frame_duration', '20',
                        '-ar', String(sampleRate),
                        '-ac', '1',
                        '-b:a', `${request.audio.max_bit_rate ?? 24}k`,
                        '-payload_type', String(request.audio.pt),
                        '-ssrc', String(info.audioSSRC),
                        '-f', 'rtp',
                        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
                        '-srtp_out_params', audioSrtpParams,
                        `srtp://${info.address}:${info.audioPort}?rtcpport=${info.audioPort}&localrtpport=${info.audioLocalPort}&pkt_size=188`
                    );
                }

                const ffmpegPath = this.ffmpegPath;
                if (ffmpegPath !== 'ffmpeg') {
                    try {
                        fs.accessSync(ffmpegPath, fs.constants.X_OK);
                    } catch {
                        log.warn('bin/ffmpeg not executable — fixing permissions (zip stripped +x)');
                        try {
                            fs.chmodSync(ffmpegPath, 0o755);
                        } catch (err) {
                            log.error('chmod failed:', (err as Error).message);
                        }
                    }
                }
                log.debug(`ffmpeg binary: ${ffmpegPath}`);
                log.debug(
                    'ffmpeg cmd: ' +
                        args.map((a) => a.replace(/rtsp:\/\/[^@]+@/, 'rtsp://***:***@').replace(srtpParams, '***').replace(audioSrtpParams, '***')).join(' ')
                );

                // ffmpeg needs the ports free — release placeholder sockets just before spawn.
                info.localSocket.close();
                info.audioLocalSocket.close();

                const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
                child.stderr?.on('data', (d: Buffer) => log.debug('[ffmpeg]', d.toString().trim()));
                child.on('error', (err) => {
                    log.error('ffmpeg spawn failed:', err.message, '— is bin/ffmpeg present and executable (aarch64)?');
                    this.ongoing.delete(sessionId);
                });
                child.on('exit', (code, signal) => {
                    log.info(`ffmpeg exited (code=${code}, signal=${signal})`);
                    this.ongoing.delete(sessionId);
                });

                this.ongoing.set(sessionId, { child, socket: info.localSocket });
                callback();
                break;
            }
            case StreamRequestTypes.RECONFIGURE:
                log.debug('RECONFIGURE ignored (-c:v copy, camera-side encode)');
                callback();
                break;
            case StreamRequestTypes.STOP: {
                const s = this.ongoing.get(sessionId);
                if (s) {
                    s.child.kill('SIGKILL');
                    this.ongoing.delete(sessionId);
                }
                log.info('Stream stopped');
                callback();
                break;
            }
        }
    }

    stopAll(): void {
        for (const s of this.ongoing.values()) {
            s.child.kill('SIGKILL');
        }
        this.ongoing.clear();
    }
}
