from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-realtime", messages=messages)
b0 = client.chat.completions.create(model='gpt-realtime', messages=messages)
a1 = client.chat.completions.create(model="gpt-audio", messages=messages)
b1 = client.chat.completions.create(model='gpt-audio', messages=messages)
a2 = client.chat.completions.create(model="gpt-4o-audio", messages=messages)
b2 = client.chat.completions.create(model='gpt-4o-audio', messages=messages)
a3 = client.chat.completions.create(model="gpt-4o-realtime", messages=messages)
b3 = client.chat.completions.create(model='gpt-4o-realtime', messages=messages)
a4 = client.chat.completions.create(model="gpt-realtime-mini", messages=messages)
b4 = client.chat.completions.create(model='gpt-realtime-mini', messages=messages)
a5 = client.chat.completions.create(model="gpt-audio-mini", messages=messages)
b5 = client.chat.completions.create(model='gpt-audio-mini', messages=messages)
a6 = client.chat.completions.create(model="gpt-4o-mini-realtime", messages=messages)
b6 = client.chat.completions.create(model='gpt-4o-mini-realtime', messages=messages)
a7 = client.chat.completions.create(model="gpt-4o-mini-audio", messages=messages)
b7 = client.chat.completions.create(model='gpt-4o-mini-audio', messages=messages)
a8 = client.chat.completions.create(model="gpt-4o-mini-transcribe-2025-03-20", messages=messages)
b8 = client.chat.completions.create(model='gpt-4o-mini-transcribe-2025-03-20', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-realtime-x", messages=messages)
