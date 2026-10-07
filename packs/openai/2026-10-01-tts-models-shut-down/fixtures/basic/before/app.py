from openai import OpenAI

client = OpenAI()

r1 = client.audio.speech.create(model="tts-1", input="Hello", voice="alloy")
r2 = client.audio.speech.create(model='tts-1', input="Hello", voice="alloy")
r3 = client.audio.speech.create(model="tts-1-hd", input="Hello", voice="alloy")
r4 = client.audio.speech.create(model='tts-1-hd', input="Hello", voice="alloy")
r5 = client.audio.speech.create(model="gpt-4o-mini-tts-2025-03-20", input="Hello", voice="alloy")
r6 = client.audio.speech.create(model='gpt-4o-mini-tts-2025-03-20', input="Hello", voice="alloy")
r7 = client.audio.speech.create(model="gpt-4o-mini-tts-2025-12-15", input="Hello", voice="alloy")
r8 = client.audio.speech.create(model='gpt-4o-mini-tts-2025-12-15', input="Hello", voice="alloy")

# Near misses: other names, not part of this shutdown.
near1 = client.audio.speech.create(model="gpt-4o-mini-tts", input="Hello", voice="alloy")
near2 = client.audio.speech.create(model="tts-1-hd-1106", input="Hello", voice="alloy")
