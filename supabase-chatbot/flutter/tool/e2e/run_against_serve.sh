#!/usr/bin/env bash
# End-to-end test of the Flutter client's network layer against a real
# `graphrt serve` running the supabase-chatbot example, with mock OpenAI and
# Supabase upstreams (no LLM key, no Supabase project).
#
#   tool/e2e/run_against_serve.sh <graphrt binary> <graphrt checkout> <supabase plugin dir>
#
# Starts the graphrt example's mock upstreams, `graphrt serve` with the same
# flags as the example's smoke test (--verify-jwt, --user-rate-limit 3), and
# fault_proxy.py (drops / stalls streams), mints HS256 user tokens, then runs
# test/e2e/serve_e2e_test.dart. Needs bash, python3, Node.js >= 20, Flutter.
set -euo pipefail

GRAPHRT=${1:?usage: run_against_serve.sh <graphrt binary> <graphrt checkout> <supabase plugin dir>}
GRAPHRT_CHECKOUT=${2:?usage: run_against_serve.sh <graphrt binary> <graphrt checkout> <supabase plugin dir>}
PLUGIN_DIR=${3:?usage: run_against_serve.sh <graphrt binary> <graphrt checkout> <supabase plugin dir>}
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd)
EXAMPLE="$GRAPHRT_CHECKOUT/examples/supabase-chatbot"
WORK=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT

OPENAI_PORT=18791 SUPABASE_PORT=18792 SERVE_PORT=18793 PROXY_PORT=18794
JWT_SECRET=e2e-test-secret-that-is-at-least-32-bytes-long
ISSUER="http://127.0.0.1:$SUPABASE_PORT/auth/v1"

python3 "$EXAMPLE/test/mock_upstreams.py" "$OPENAI_PORT" "$SUPABASE_PORT" "$WORK/supabase.log" &
python3 "$HERE/fault_proxy.py" "$PROXY_PORT" "$SERVE_PORT" &

make_jwt() { # $1 = subject, $2 = seconds until expiry (negative: already expired)
  python3 - "$JWT_SECRET" "$ISSUER" "$1" "$2" <<'PY'
import base64, hashlib, hmac, json, sys, time
secret, issuer, subject, ttl = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
b64 = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
claims = {"sub": subject, "role": "authenticated", "aud": "authenticated", "iss": issuer,
          "iat": int(time.time()) - 3600, "exp": int(time.time()) + ttl}
payload = b64(json.dumps(claims).encode())
signature = b64(hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
print(f"{header}.{payload}.{signature}")
PY
}

OPENAI_API_KEY=mock OPENAI_BASE_URL="http://127.0.0.1:$OPENAI_PORT/v1" \
SUPABASE_URL="http://127.0.0.1:$SUPABASE_PORT" SUPABASE_KEY=sb_publishable_mock \
SUPABASE_TOOL_MODE=user_rpc \
SUPABASE_TOOL_RPC_ALLOWLIST=get_my_profile,list_diary_entries,list_important_dates,list_chat_messages,start_chat_session,add_chat_message \
SUPABASE_TOOL_TIMEOUT_MS=8000 SUPABASE_TOOL_MAX_ROWS=50 \
SUPABASE_JWT_SECRET="$JWT_SECRET" \
"$GRAPHRT" serve "$EXAMPLE/agent.yaml" --addr "127.0.0.1:$SERVE_PORT" \
  --plugins "$PLUGIN_DIR" --no-default-plugins --trust-plugin supabase \
  --input-header user_jwt=X-User-Authorization \
  --verify-jwt user_jwt --jwt-secret-env SUPABASE_JWT_SECRET \
  --jwt-issuer "$ISSUER" --jwt-audience authenticated \
  --user-rate-limit 3 --max-body-bytes 65536 2>"$WORK/serve.log" &
for _ in $(seq 100); do curl -fs "http://127.0.0.1:$SERVE_PORT/healthz" >/dev/null && break; sleep 0.1; done
curl -fs "http://127.0.0.1:$SERVE_PORT/healthz" >/dev/null || { cat "$WORK/serve.log"; exit 1; }

cd "$APP_DIR"
E2E_SERVE_URL="http://127.0.0.1:$SERVE_PORT/" \
E2E_PROXY_URL="http://127.0.0.1:$PROXY_PORT/" \
E2E_JWT_STREAM=$(make_jwt user-stream 600) \
E2E_JWT_REFRESH_EXPIRED=$(make_jwt user-refresh -60) \
E2E_JWT_REFRESH_VALID=$(make_jwt user-refresh 600) \
E2E_JWT_LIMIT=$(make_jwt user-limit 600) \
E2E_JWT_DROP=$(make_jwt user-drop 600) \
E2E_JWT_STALL=$(make_jwt user-stall 600) \
flutter test test/e2e/serve_e2e_test.dart --reporter expanded || { echo "--- serve log"; cat "$WORK/serve.log"; exit 1; }
