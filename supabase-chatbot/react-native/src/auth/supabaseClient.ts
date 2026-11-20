/**
 * The Supabase client, created once from the app config.
 *
 * Sessions persist in AsyncStorage and refresh automatically while the app is in
 * the foreground (the setup Supabase recommends for React Native).
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import type { AppConfig } from '../config.ts';

let sharedClient: SupabaseClient | undefined;

/**
 * Get (or create) the app's Supabase client.
 *
 * @param config - Supabase URL and anon key (AppConfig)
 * @returns The shared client (SupabaseClient)
 */
export function getSupabaseClient(config: AppConfig): SupabaseClient {
  if (sharedClient) {
    return sharedClient;
  }
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  });
  AppState.addEventListener('change', (appState) => {
    if (appState === 'active') {
      client.auth.startAutoRefresh();
    } else {
      client.auth.stopAutoRefresh();
    }
  });
  sharedClient = client;
  return client;
}

/** The current access token; getSession refreshes it first when it has expired. */
export async function getAccessToken(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    throw error ?? new Error('Not signed in.');
  }
  return data.session.access_token;
}

/** Force a refresh (after serve answered 401) and return the new access token. */
export async function refreshAccessToken(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.refreshSession();
  if (error || !data.session) {
    throw error ?? new Error('Session refresh failed.');
  }
  return data.session.access_token;
}
