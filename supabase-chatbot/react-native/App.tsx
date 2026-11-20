/**
 * Root: validates the config, then shows the login screen or the chat depending
 * on the Supabase session.
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';
import { parseConfig, readEnvironment, type AppConfig } from './src/config.ts';
import { getSupabaseClient } from './src/auth/supabaseClient.ts';
import { ChatScreen } from './src/ui/ChatScreen.tsx';
import { LoginScreen } from './src/ui/LoginScreen.tsx';
import { colors } from './src/ui/theme.ts';

export default function App() {
  const configResult = useMemo(() => parseConfig(readEnvironment()), []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        {configResult.ok ? (
          <AuthenticatedApp config={configResult.config} />
        ) : (
          <View style={styles.centered}>
            <Text style={styles.problemTitle}>Configuration missing</Text>
            {configResult.problems.map((problem) => (
              <Text key={problem} style={styles.problem}>
                {problem}
              </Text>
            ))}
            <Text style={styles.problem}>Copy .env.example to .env.local and restart Expo.</Text>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function AuthenticatedApp({ config }: { config: AppConfig }) {
  const client = useMemo(() => getSupabaseClient(config), [config]);
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, [client]);

  if (session === undefined) {
    return <ActivityIndicator style={styles.centered} color={colors.accent} />;
  }
  // Keyed by user so switching accounts never shows the previous user's chat.
  return session ? (
    <ChatScreen key={session.user.id} config={config} client={client} />
  ) : (
    <LoginScreen client={client} />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  problemTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
  problem: { color: colors.danger, textAlign: 'center' },
});
