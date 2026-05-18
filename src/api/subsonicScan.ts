import { apiForServer } from './subsonicClient';

export interface ScanStatus {
  scanning: boolean;
  count: number;
  folderCount?: number;
  lastScan?: string;
}

export async function startScan(serverId: string, fullScan: boolean): Promise<void> {
  await apiForServer(serverId, 'startScan.view', fullScan ? { fullScan: 'true' } : {}, 10000);
}

export async function getScanStatus(serverId: string): Promise<ScanStatus> {
  const data = await apiForServer<{ scanStatus?: ScanStatus }>(serverId, 'getScanStatus.view', {}, 8000);
  const s = data.scanStatus;
  return {
    scanning: !!s?.scanning,
    count: typeof s?.count === 'number' ? s.count : 0,
    folderCount: typeof s?.folderCount === 'number' ? s.folderCount : undefined,
    lastScan: typeof s?.lastScan === 'string' ? s.lastScan : undefined,
  };
}
