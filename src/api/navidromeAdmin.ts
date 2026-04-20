import { invoke } from '@tauri-apps/api/core';

export interface NdLibrary {
  id: number;
  name: string;
}

export interface NdUser {
  id: string;
  userName: string;
  name: string;
  email: string;
  isAdmin: boolean;
  libraryIds: number[];
  lastLoginAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NdLoginResult {
  token: string;
  userId: string;
  isAdmin: boolean;
}

export async function ndLogin(
  serverUrl: string,
  username: string,
  password: string,
): Promise<NdLoginResult> {
  return invoke<NdLoginResult>('navidrome_login', { serverUrl, username, password });
}

function extractLibraryIds(o: Record<string, unknown>): number[] {
  const libs = o.libraries;
  if (!Array.isArray(libs)) return [];
  const ids: number[] = [];
  for (const l of libs) {
    const id = (l as Record<string, unknown>)?.id;
    if (typeof id === 'number') ids.push(id);
    else if (typeof id === 'string' && /^\d+$/.test(id)) ids.push(Number(id));
  }
  return ids;
}

export async function ndListUsers(serverUrl: string, token: string): Promise<NdUser[]> {
  const raw = await invoke<unknown>('nd_list_users', { serverUrl, token });
  if (!Array.isArray(raw)) return [];
  return raw.map(u => {
    const o = u as Record<string, unknown>;
    return {
      id: String(o.id ?? ''),
      userName: String(o.userName ?? ''),
      name: String(o.name ?? ''),
      email: String(o.email ?? ''),
      isAdmin: !!o.isAdmin,
      libraryIds: extractLibraryIds(o),
      lastLoginAt: (o.lastLoginAt as string | null | undefined) ?? null,
      createdAt: o.createdAt as string | undefined,
      updatedAt: o.updatedAt as string | undefined,
    };
  });
}

export async function ndListLibraries(serverUrl: string, token: string): Promise<NdLibrary[]> {
  const raw = await invoke<unknown>('nd_list_libraries', { serverUrl, token });
  if (!Array.isArray(raw)) return [];
  return raw.map(l => {
    const o = l as Record<string, unknown>;
    const id = typeof o.id === 'number'
      ? o.id
      : typeof o.id === 'string' && /^\d+$/.test(o.id) ? Number(o.id) : 0;
    return { id, name: String(o.name ?? '') };
  }).filter(l => l.id > 0);
}

export async function ndSetUserLibraries(
  serverUrl: string,
  token: string,
  id: string,
  libraryIds: number[],
): Promise<void> {
  await invoke('nd_set_user_libraries', { serverUrl, token, id, libraryIds });
}

export async function ndCreateUser(
  serverUrl: string,
  token: string,
  data: { userName: string; name: string; email: string; password: string; isAdmin: boolean },
): Promise<{ id: string }> {
  const raw = await invoke<unknown>('nd_create_user', { serverUrl, token, ...data });
  const o = (raw as Record<string, unknown> | null) ?? {};
  return { id: String(o.id ?? '') };
}

export async function ndUpdateUser(
  serverUrl: string,
  token: string,
  id: string,
  data: { userName: string; name: string; email: string; password: string; isAdmin: boolean },
): Promise<void> {
  await invoke('nd_update_user', { serverUrl, token, id, ...data });
}

export async function ndDeleteUser(serverUrl: string, token: string, id: string): Promise<void> {
  await invoke('nd_delete_user', { serverUrl, token, id });
}
