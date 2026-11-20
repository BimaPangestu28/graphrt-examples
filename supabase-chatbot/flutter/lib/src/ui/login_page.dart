import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Email + password sign-in (and sign-up) with Supabase Auth.
class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.auth});
  final GoTrueClient auth;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isBusy = false;
  String? _statusText;

  Future<void> _submit({required bool isSignUp}) async {
    final email = _emailController.text.trim();
    final password = _passwordController.text;
    if (email.isEmpty || password.length < 6) {
      setState(() => _statusText = 'Enter an email and a 6+ char password.');
      return;
    }
    setState(() {
      _isBusy = true;
      _statusText = null;
    });
    try {
      if (isSignUp) {
        final signUpResult = await widget.auth.signUp(
          email: email,
          password: password,
        );
        if (signUpResult.session == null && mounted) {
          setState(
            () => _statusText =
                'Check your email to confirm, then '
                'sign in.',
          );
        }
      } else {
        await widget.auth.signInWithPassword(email: email, password: password);
      }
    } on AuthException catch (error) {
      if (mounted) setState(() => _statusText = error.message);
    } catch (error) {
      if (mounted) setState(() => _statusText = 'Sign-in failed: $error');
    } finally {
      if (mounted) setState(() => _isBusy = false);
    }
  }

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Chatbot',
                      style: Theme.of(context).textTheme.headlineMedium,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 24),
                    TextField(
                      controller: _emailController,
                      decoration: const InputDecoration(labelText: 'Email'),
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                    ),
                    TextField(
                      controller: _passwordController,
                      decoration: const InputDecoration(labelText: 'Password'),
                      obscureText: true,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _submit(isSignUp: false),
                    ),
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: _isBusy
                          ? null
                          : () => _submit(isSignUp: false),
                      child: const Text('Sign in'),
                    ),
                    TextButton(
                      onPressed: _isBusy ? null : () => _submit(isSignUp: true),
                      child: const Text('Create account'),
                    ),
                    if (_statusText != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Text(_statusText!, textAlign: TextAlign.center),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
