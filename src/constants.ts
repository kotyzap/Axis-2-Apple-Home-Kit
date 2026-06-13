export const SNAPSHOT_TIMEOUT_MS = 5000;
export const SNAPSHOT_CACHE_MS = 900; // serve cached JPEG if HomeKit hammers us
export const RETRY_DELAY_MS = 5000;

// Fixed HomeKit setup ID (4 chars, 0-9/A-Z). Pinned so the settings UI can
// render the pairing QR (X-HM://...) without querying the running accessory.
// Keep in sync with SETUP_ID in html/index.js.
export const HOMEKIT_SETUP_ID = 'AXIS';
