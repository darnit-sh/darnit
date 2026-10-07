from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="whisper-1", messages=messages)
b0 = client.chat.completions.create(model='whisper-1', messages=messages)
a1 = client.chat.completions.create(model="gpt-4o-transcribe", messages=messages)
b1 = client.chat.completions.create(model='gpt-4o-transcribe', messages=messages)
a2 = client.chat.completions.create(model="gpt-4o-mini-transcribe", messages=messages)
b2 = client.chat.completions.create(model='gpt-4o-mini-transcribe', messages=messages)
a3 = client.chat.completions.create(model="gpt-4o-transcribe-diarize", messages=messages)
b3 = client.chat.completions.create(model='gpt-4o-transcribe-diarize', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="whisper-1-x", messages=messages)
