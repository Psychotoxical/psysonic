export type LibraryServerConnection = 'online' | 'offline' | 'unknown';

let connectionByServer: Record<string, LibraryServerConnection> = {};
let connectionPublisher: ((indexKey: string, connection: LibraryServerConnection) => void) | null = null;

export function replaceLibraryServerConnectionSnapshot(
  next: Record<string, LibraryServerConnection>,
): void {
  connectionByServer = next;
}

export function getLibraryServerConnection(indexKey: string): LibraryServerConnection {
  return connectionByServer[indexKey] ?? 'unknown';
}

export function registerLibraryServerConnectionPublisher(
  publisher: (indexKey: string, connection: LibraryServerConnection) => void,
): void {
  connectionPublisher = publisher;
}

export function publishLibraryServerConnection(
  indexKey: string,
  connection: LibraryServerConnection,
): void {
  connectionByServer = { ...connectionByServer, [indexKey]: connection };
  connectionPublisher?.(indexKey, connection);
}

export function resetLibraryServerConnectionSnapshot(): void {
  connectionByServer = {};
}
