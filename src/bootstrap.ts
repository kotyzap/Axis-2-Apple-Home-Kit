// Entry point. Reads settings BEFORE hap-nodejs is loaded so the HAP debug
// flag (DEBUG=HAP-NodeJS:*) can take effect — the 'debug' package reads the
// env var at import time.
import * as fs from 'fs';
import * as path from 'path';

const PERSISTENT_DATA_PATH = process.env.PERSISTENT_DATA_PATH ?? './localdata/';
try {
    const raw = JSON.parse(fs.readFileSync(path.join(PERSISTENT_DATA_PATH, 'settings.json'), 'utf8'));
    if (raw?.homekit?.debug === true) {
        process.env.DEBUG = 'HAP-NodeJS:*';
        console.log('HAP debug logging enabled (DEBUG=HAP-NodeJS:*)');
    }
} catch {
    /* no settings yet */
}

require('./main');
