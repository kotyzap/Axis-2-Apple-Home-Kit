import { TSettings } from './schema';
import { vapixGet } from './snapshot';
import { log } from './logger';

export type DeviceInfo = {
    model?: string; // e.g. "M1137"
    name?: string; // e.g. "AXIS M1137"
    firmware?: string; // e.g. "11.11.61"
    serial?: string; // camera serial / MAC
};

// Read identity from the host camera via VAPIX param.cgi. param.cgi returns
// lines like "root.Brand.ProdNbr=M1137" — tolerant of the optional "root." prefix.
export async function fetchDeviceInfo(settings: TSettings): Promise<DeviceInfo> {
    try {
        const body = (
            await vapixGet(
                settings.camera,
                '/axis-cgi/param.cgi?action=list&group=Brand,Properties.Firmware.Version,Properties.System.SerialNumber'
            )
        ).toString('utf8');

        const pick = (key: string): string | undefined => {
            const m = new RegExp(`^(?:root\\.)?${key.replace(/\./g, '\\.')}=(.*)$`, 'm').exec(body);
            return m ? m[1].trim() : undefined;
        };

        const info: DeviceInfo = {
            model: pick('Brand.ProdNbr'),
            name: pick('Brand.ProdShortName') ?? pick('Brand.ProdFullName'),
            firmware: pick('Properties.Firmware.Version'),
            serial: pick('Properties.System.SerialNumber'),
        };
        log.info(
            `Device info: model=${info.model ?? '?'} firmware=${info.firmware ?? '?'} serial=${info.serial ?? '?'}`
        );
        return info;
    } catch (err) {
        log.warn('Could not read device info (using defaults):', (err as Error).message);
        return {};
    }
}
