import logging

import httpx
import requests
from openai import OpenAI

client = OpenAI()
BASE = "https://api.openai.com"

# The SDK call is rewritten as in basic/; every quoted key below is reported, not rewritten.
res = client.chat.completions.create(model="gpt-4o", messages=[], max_completion_tokens=256)
unpacked = client.chat.completions.create(**{"model": "gpt-4o", "messages": [], "max_tokens": 256})

# Raw HTTP to chat completions, the key in double or single quotes.
a = requests.post("https://api.openai.com/v1/chat/completions", json={"model": "gpt-4o", "messages": [], "max_tokens": 100})
b = requests.post("https://api.openai.com/v1/chat/completions", json={'max_tokens': 100})
c = httpx.post(url=f"{BASE}/v1/chat/completions", json={"max_tokens": 100})

# Not an OpenAI chat completions request: another vendor, legacy completions, a config dict,
# a log message, and a payload passed by name (not checked; the report says so).
d = requests.post("https://api.anthropic.com/v1/messages", json={"max_tokens": 100})
e = requests.post("https://api.openai.com/v1/completions", json={"max_tokens": 100})
DEFAULTS = {"max_tokens": 100}
logging.info("posting {'max_tokens': 100} to /v1/chat/completions")
logging.info("posting to /v1/chat/completions", extra={"max_tokens": 100})
payload = {"max_tokens": 100}
f = requests.post("https://api.openai.com/v1/chat/completions", json=payload)
