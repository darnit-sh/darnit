from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-5-2025-08-07", messages=messages)
b0 = client.chat.completions.create(model='gpt-5-2025-08-07', messages=messages)
a1 = client.chat.completions.create(model="gpt-5-mini-2025-08-07", messages=messages)
b1 = client.chat.completions.create(model='gpt-5-mini-2025-08-07', messages=messages)
a2 = client.chat.completions.create(model="gpt-5-nano-2025-08-07", messages=messages)
b2 = client.chat.completions.create(model='gpt-5-nano-2025-08-07', messages=messages)
a3 = client.chat.completions.create(model="gpt-5-pro-2025-10-06", messages=messages)
b3 = client.chat.completions.create(model='gpt-5-pro-2025-10-06', messages=messages)
a4 = client.chat.completions.create(model="o3-2025-04-16", messages=messages)
b4 = client.chat.completions.create(model='o3-2025-04-16', messages=messages)
a5 = client.chat.completions.create(model="o3-pro-2025-06-10", messages=messages)
b5 = client.chat.completions.create(model='o3-pro-2025-06-10', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-5-2025-08-07-x", messages=messages)
