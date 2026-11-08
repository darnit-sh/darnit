from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-4o", messages=messages)
b0 = client.chat.completions.create(model='gpt-4o', messages=messages)
a1 = client.chat.completions.create(model="gpt-4o-mini", messages=messages)
b1 = client.chat.completions.create(model='gpt-4o-mini', messages=messages)
a2 = client.chat.completions.create(model="gpt-4.1", messages=messages)
b2 = client.chat.completions.create(model='gpt-4.1', messages=messages)
a3 = client.chat.completions.create(model="gpt-4.1-mini", messages=messages)
b3 = client.chat.completions.create(model='gpt-4.1-mini', messages=messages)
a4 = client.chat.completions.create(model="gpt-4o-2024-08-06", messages=messages)
b4 = client.chat.completions.create(model='gpt-4o-2024-08-06', messages=messages)
a5 = client.chat.completions.create(model="gpt-4o-2024-11-20", messages=messages)
b5 = client.chat.completions.create(model='gpt-4o-2024-11-20', messages=messages)
a6 = client.chat.completions.create(model="gpt-4o-mini-2024-07-18", messages=messages)
b6 = client.chat.completions.create(model='gpt-4o-mini-2024-07-18', messages=messages)
a7 = client.chat.completions.create(model="gpt-4.1-2025-04-14", messages=messages)
b7 = client.chat.completions.create(model='gpt-4.1-2025-04-14', messages=messages)
a8 = client.chat.completions.create(model="gpt-4.1-mini-2025-04-14", messages=messages)
b8 = client.chat.completions.create(model='gpt-4.1-mini-2025-04-14', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-4o-x", messages=messages)
