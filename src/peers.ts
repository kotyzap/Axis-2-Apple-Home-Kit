import bonjour from 'bonjour-hap';
import { log } from './logger';

// Announce this bridge instance on the LAN and listen for sibling instances
// (other Axis cameras running fourxs_apple_home_kit in the same home). Used by the
// soft Ko-fi gate: first camera is free, additional ones ask for a coffee.
export class PeerMonitor {
    private instance = bonjour();
    private peers = new Map<string, { name: string; host: string }>();

    constructor(
        private selfId: string, // HAP username (unique per install)
        private port: number
    ) {}

    // Browse only — call announce() separately once the accessory actually
    // publishes, so two fresh installs can't block each other.
    startBrowse(): void {
        try {
            const browser = this.instance.find({ type: 'apple-home-kit' });
            browser.on('up', (service: { name: string; host?: string; txt?: Record<string, string> }) => {
                const id = service.txt?.id ?? service.name;
                if (id === this.selfId) {
                    return; // that's us
                }
                this.peers.set(id, { name: service.name, host: service.host ?? '' });
                log.info(`Peer bridge detected on network: ${service.name} (${service.host ?? '?'})`);
            });
            browser.on('down', (service: { name: string; txt?: Record<string, string> }) => {
                const id = service.txt?.id ?? service.name;
                this.peers.delete(id);
            });
        } catch (err) {
            log.error('PeerMonitor browse failed (gate disabled):', (err as Error).message);
        }
    }

    announce(): void {
        try {
            this.instance.publish({
                name: `apple-home-kit ${this.selfId.replace(/:/g, '')}`,
                type: 'apple-home-kit',
                port: this.port,
                txt: { id: this.selfId },
            });
        } catch (err) {
            log.error('PeerMonitor announce failed:', (err as Error).message);
        }
    }

    get peerCount(): number {
        return this.peers.size;
    }

    get peerList(): { name: string; host: string }[] {
        return [...this.peers.values()];
    }

    stop(): void {
        try {
            this.instance.destroy();
        } catch {
            /* ignore */
        }
    }
}
