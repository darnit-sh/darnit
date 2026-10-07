from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-4o-realtime-preview", messages=messages)
b0 = client.chat.completions.create(model='gpt-4o-realtime-preview', messages=messages)
a1 = client.chat.completions.create(model="gpt-4o-realtime-preview-2025-06-03", messages=messages)
b1 = client.chat.completions.create(model='gpt-4o-realtime-preview-2025-06-03', messages=messages)
a2 = client.chat.completions.create(model="gpt-4o-realtime-preview-2024-12-17", messages=messages)
b2 = client.chat.completions.create(model='gpt-4o-realtime-preview-2024-12-17', messages=messages)
a3 = client.chat.completions.create(model="gpt-4o-mini-realtime-preview", messages=messages)
b3 = client.chat.completions.create(model='gpt-4o-mini-realtime-preview', messages=messages)
a4 = client.chat.completions.create(model="gpt-4o-audio-preview", messages=messages)
b4 = client.chat.completions.create(model='gpt-4o-audio-preview', messages=messages)
a5 = client.chat.completions.create(model="gpt-4o-mini-audio-preview", messages=messages)
b5 = client.chat.completions.create(model='gpt-4o-mini-audio-preview', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-4o-realtime-preview-x", messages=messages)
