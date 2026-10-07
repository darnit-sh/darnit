from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="tts-1", messages=messages)
b0 = client.chat.completions.create(model='tts-1', messages=messages)
a1 = client.chat.completions.create(model="tts-1-hd", messages=messages)
b1 = client.chat.completions.create(model='tts-1-hd', messages=messages)
a2 = client.chat.completions.create(model="gpt-4o-mini-tts-2025-03-20", messages=messages)
b2 = client.chat.completions.create(model='gpt-4o-mini-tts-2025-03-20', messages=messages)
a3 = client.chat.completions.create(model="gpt-4o-mini-tts-2025-12-15", messages=messages)
b3 = client.chat.completions.create(model='gpt-4o-mini-tts-2025-12-15', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="tts-1-x", messages=messages)
