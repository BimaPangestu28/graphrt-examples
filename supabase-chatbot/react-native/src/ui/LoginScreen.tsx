/**
 * Email + password sign-in with Supabase Auth. "Create account" signs up; when
 * the project requires email confirmation the user is told to check their inbox.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import { colors } from './theme.ts';

type AuthMode = 'sign_in' | 'sign_up';

export function LoginScreen({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const submitCredentials = async (mode: AuthMode): Promise<void> => {
    if (!email.trim() || password.length < 6) {
      setFeedback('Enter your email and a password of at least 6 characters.');
      return;
    }
    setIsBusy(true);
    setFeedback(null);
    const credentials = { email: email.trim(), password };
    const { data, error } =
      mode === 'sign_in' ? await client.auth.signInWithPassword(credentials) : await client.auth.signUp(credentials);
    setIsBusy(false);
    if (error) {
      setFeedback(error.message);
    } else if (mode === 'sign_up' && !data.session) {
      setFeedback('Check your inbox to confirm your email, then sign in.');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign in</Text>
      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        autoComplete="password"
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={() => submitCredentials('sign_in')}
      />
      {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
      {isBusy ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <View style={styles.actions}>
          <Pressable style={styles.primaryButton} onPress={() => submitCredentials('sign_in')}>
            <Text style={styles.primaryButtonText}>Sign in</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => submitCredentials('sign_up')}>
            <Text style={styles.secondaryButtonText}>Create account</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: colors.background },
  title: { fontSize: 28, fontWeight: '700', color: colors.text, marginBottom: 8 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  feedback: { color: colors.danger },
  actions: { gap: 10 },
  primaryButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  primaryButtonText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  secondaryButton: { paddingVertical: 12, alignItems: 'center' },
  secondaryButtonText: { color: colors.accent, fontSize: 16 },
});
