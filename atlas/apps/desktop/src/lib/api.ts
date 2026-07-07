import { invoke } from '@tauri-apps/api/core';

/// Reads the crate version from the Rust side. Proves the IPC bridge works.
export async function getAppVersion(): Promise<string> {
  return invoke<string>('app_version');
}
