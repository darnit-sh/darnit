from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="codex-mini-latest", messages=messages)
b0 = client.chat.completions.create(model='codex-mini-latest', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="codex-mini-latest-x", messages=messages)
