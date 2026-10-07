from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-5.3-codex", messages=messages)
b0 = client.chat.completions.create(model='gpt-5.3-codex', messages=messages)
a1 = client.chat.completions.create(model="gpt-5.4-nano", messages=messages)
b1 = client.chat.completions.create(model='gpt-5.4-nano', messages=messages)
a2 = client.chat.completions.create(model="gpt-5.1", messages=messages)
b2 = client.chat.completions.create(model='gpt-5.1', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-5.3-codex-x", messages=messages)
