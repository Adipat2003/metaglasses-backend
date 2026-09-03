import os

# Unit tests never depend on a hosted identity provider. Integration tests can
# construct an authenticated app with a fake verifier or use the local Supabase stack.
os.environ["APP_ENV"] = "local"
os.environ["AUTH_MODE"] = "disabled"
os.environ.pop("SUPABASE_URL", None)
