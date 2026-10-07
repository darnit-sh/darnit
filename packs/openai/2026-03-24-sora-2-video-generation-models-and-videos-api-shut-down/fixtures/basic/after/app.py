from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="sora-2", messages=messages)
b0 = client.chat.completions.create(model='sora-2', messages=messages)
a1 = client.chat.completions.create(model="sora-2-pro", messages=messages)
b1 = client.chat.completions.create(model='sora-2-pro', messages=messages)
a2 = client.chat.completions.create(model="sora-2-2025-10-06", messages=messages)
b2 = client.chat.completions.create(model='sora-2-2025-10-06', messages=messages)
a3 = client.chat.completions.create(model="sora-2-2025-12-08", messages=messages)
b3 = client.chat.completions.create(model='sora-2-2025-12-08', messages=messages)
a4 = client.chat.completions.create(model="sora-2-pro-2025-10-06", messages=messages)
b4 = client.chat.completions.create(model='sora-2-pro-2025-10-06', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="sora-2-x", messages=messages)
