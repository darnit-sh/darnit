from openai import OpenAI

client = OpenAI()

r1 = client.chat.completions.create(model="gpt-5.1", messages=messages)
r2 = client.chat.completions.create(model='gpt-5.1', messages=messages)
r3 = client.chat.completions.create(model="gpt-5.3-codex", messages=messages)
r4 = client.chat.completions.create(model='gpt-5.3-codex', messages=messages)
r5 = client.chat.completions.create(model="gpt-5.4-nano", messages=messages)
r6 = client.chat.completions.create(model='gpt-5.4-nano', messages=messages)

# Near misses: other names, not part of this shutdown.
near1 = client.chat.completions.create(model="gpt-5.1-mini", messages=messages)
near2 = client.chat.completions.create(model="gpt-5.1-codex", messages=messages)
near3 = client.chat.completions.create(model="gpt-5.4-nano-2026-01-01", messages=messages)
