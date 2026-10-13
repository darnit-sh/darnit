import os

MODEL = os.getenv("APP_MODEL", "gpt-4-1106-preview")
judge = os.environ.get("JUDGE", "gpt-4-turbo")
other = os.environ.get("OTHER") or "o1-mini"
