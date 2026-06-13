import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { TSettings } from './schema';
import { SNAPSHOT_CACHE_MS, SNAPSHOT_TIMEOUT_MS } from './constants';

// Minimal VAPIX JPEG snapshot fetcher with Basic + Digest auth support.
// Axis cameras default to Digest; node-fetch doesn't do Digest, so we roll our own.

let cache: { buf: Buffer; at: number } | undefined;
let authScheme: 'basic' | 'digest' | undefined;

function basicHeader(cam: TSettings['camera']): string {
    return 'Basic ' + Buffer.from(`${cam.user}:${cam.pass}`).toString('base64');
}

function rawGet(
    cam: TSettings['camera'],
    path: string,
    authHeader?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const mod = cam.protocol === 'https' ? https : http;
        const req = mod.request(
            {
                host: cam.ip,
                port: cam.port,
                path,
                method: 'GET',
                timeout: SNAPSHOT_TIMEOUT_MS,
                rejectUnauthorized: false,
                headers: authHeader ? { Authorization: authHeader } : {},
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () =>
                    resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
                );
            }
        );
        req.on('timeout', () => req.destroy(new Error('Snapshot request timeout')));
        req.on('error', reject);
        req.end();
    });
}

function digestHeader(cam: TSettings['camera'], path: string, wwwAuth: string): string {
    const get = (k: string) => new RegExp(`${k}="?([^",]+)"?`).exec(wwwAuth)?.[1] ?? '';
    const realm = get('realm');
    const nonce = get('nonce');
    const qop = get('qop');
    const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
    const ha1 = md5(`${cam.user}:${realm}:${cam.pass}`);
    const ha2 = md5(`GET:${path}`);
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const response = qop
        ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        : md5(`${ha1}:${nonce}:${ha2}`);
    let h =
        `Digest username="${cam.user}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${response}"`;
    if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    return h;
}

// One authenticated GET, with the camera's Basic/Digest challenge handled.
async function requestWithAuth(
    cam: TSettings['camera'],
    path: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    // Remember the camera's auth scheme after the first challenge. Basic can be
    // sent pre-emptively (one request instead of two); Digest always needs a
    // fresh nonce, so it keeps the challenge round trip.
    let res = await rawGet(cam, path, authScheme === 'basic' ? basicHeader(cam) : undefined);
    if (res.status === 401) {
        // The camera may offer multiple challenges ("Basic ..., Digest ...").
        // Always prefer Digest — modern AXIS OS disables Basic by default.
        const wwwAuth = Array.isArray(res.headers['www-authenticate'])
            ? (res.headers['www-authenticate'] as string[]).join(', ')
            : String(res.headers['www-authenticate'] ?? '');
        const digestIdx = wwwAuth.search(/digest\s/i);
        const useDigest = digestIdx >= 0;
        if (authScheme === undefined) {
            console.log(`[snapshot] VAPIX uses ${useDigest ? 'Digest' : 'Basic'} auth`);
        }
        authScheme = useDigest ? 'digest' : 'basic';
        const auth = useDigest ? digestHeader(cam, path, wwwAuth.slice(digestIdx)) : basicHeader(cam);
        res = await rawGet(cam, path, auth);
    }
    return res;
}

// Generic authenticated VAPIX GET returning the raw body (used for param.cgi).
export async function vapixGet(cam: TSettings['camera'], path: string): Promise<Buffer> {
    const res = await requestWithAuth(cam, path);
    if (res.status !== 200) {
        throw new Error(`VAPIX GET ${path} failed: HTTP ${res.status}`);
    }
    return res.body;
}

export async function fetchSnapshot(settings: TSettings): Promise<Buffer> {
    if (cache && Date.now() - cache.at < SNAPSHOT_CACHE_MS) {
        return cache.buf;
    }
    const cam = settings.camera;
    const path = `/axis-cgi/jpg/image.cgi?resolution=${settings.homekit.snapshot_resolution}`;

    const res = await requestWithAuth(cam, path);
    if (res.status !== 200) {
        if (res.status === 401) {
            throw new Error('Snapshot failed: HTTP 401 after auth retry — check user/password (and that the account has viewer rights)');
        }
        throw new Error(`Snapshot failed: HTTP ${res.status}`);
    }
    cache = { buf: res.body, at: Date.now() };
    return res.body;
}
