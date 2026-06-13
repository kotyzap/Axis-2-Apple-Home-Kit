// Shared, in-memory progress state surfaced to the settings UI via /status.cgi.
// Lives in its own module (no imports) so both main.ts and stream.ts can update
// it without a circular dependency.
export const status = {
    configured: false, // camera credentials present
    published: false, // HomeKit accessory advertised on the LAN
    paired: false, // a Home-app controller has completed pairing
    snapshotSent: false, // at least one JPEG has been delivered to HomeKit
};

export function markSnapshotSent(): void {
    status.snapshotSent = true;
    // HomeKit only pulls snapshots from a paired controller, so a delivered
    // snapshot is proof of pairing — set it even if the 'paired' event never fired.
    status.paired = true;
}
