function ts(): string {
    return new Date().toISOString();
}

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
    debugEnabled = enabled;
}

export const log = {
    info: (...a: unknown[]) => console.log(`[${ts()}] [INFO ]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[${ts()}] [WARN ]`, ...a),
    error: (...a: unknown[]) => console.error(`[${ts()}] [ERROR]`, ...a),
    debug: (...a: unknown[]) => {
        if (debugEnabled) {
            console.log(`[${ts()}] [DEBUG]`, ...a);
        }
    },
};
