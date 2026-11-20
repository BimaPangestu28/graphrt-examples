import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'src/app_config.dart';
import 'src/auth/supabase_access_token.dart';
import 'src/chat/chat_controller.dart';
import 'src/chat/chat_history_store.dart';
import 'src/serve/serve_client.dart';
import 'src/ui/chat_page.dart';
import 'src/ui/login_page.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final appConfig = AppConfig.fromEnvironment();
  final configProblems = appConfig.validate();
  if (configProblems.isNotEmpty) {
    runApp(ConfigErrorApp(problems: configProblems));
    return;
  }
  await Supabase.initialize(
    url: appConfig.supabaseUrl,
    publishableKey: appConfig.supabaseAnonKey,
  );
  runApp(ChatbotApp(appConfig: appConfig, supabase: Supabase.instance.client));
}

class ChatbotApp extends StatelessWidget {
  const ChatbotApp({
    super.key,
    required this.appConfig,
    required this.supabase,
  });
  final AppConfig appConfig;
  final SupabaseClient supabase;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Chatbot',
      theme: ThemeData(colorSchemeSeed: Colors.indigo),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        brightness: Brightness.dark,
      ),
      home: StreamBuilder<AuthState>(
        stream: supabase.auth.onAuthStateChange,
        builder: (context, _) {
          final currentUser = supabase.auth.currentUser;
          if (currentUser == null) return LoginPage(auth: supabase.auth);
          return SignedInChat(
            key: ValueKey(currentUser.id),
            appConfig: appConfig,
            supabase: supabase,
          );
        },
      ),
    );
  }
}

/// Owns the per-user [ChatController] and [ServeClient].
class SignedInChat extends StatefulWidget {
  const SignedInChat({
    super.key,
    required this.appConfig,
    required this.supabase,
  });
  final AppConfig appConfig;
  final SupabaseClient supabase;

  @override
  State<SignedInChat> createState() => _SignedInChatState();
}

class _SignedInChatState extends State<SignedInChat> {
  late final ServeClient _serveClient = ServeClient(
    serveUrl: widget.appConfig.serveBaseUri,
    workflowName: widget.appConfig.workflowName,
    accessTokenProvider: supabaseAccessTokenProvider(widget.supabase.auth),
  );
  late final ChatController _chatController = ChatController(
    runStreamer: _serveClient.streamRun,
    historyStore: SupabaseChatHistoryStore(widget.supabase),
  );

  @override
  void dispose() {
    _chatController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ChatPage(
    controller: _chatController,
    onSignOut: () => widget.supabase.auth.signOut(),
  );
}

/// Shown instead of the app when `--dart-define` values are missing.
class ConfigErrorApp extends StatelessWidget {
  const ConfigErrorApp({super.key, required this.problems});
  final List<String> problems;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              'Configuration error:\n\n${problems.join('\n')}\n\n'
              'Run with --dart-define-from-file=config.json '
              '(see config.example.json).',
            ),
          ),
        ),
      ),
    );
  }
}
