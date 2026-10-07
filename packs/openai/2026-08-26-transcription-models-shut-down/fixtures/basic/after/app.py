from openai import OpenAI

client = OpenAI()

r1 = client.audio.transcriptions.create(model="whisper-1", file=f)
r2 = client.audio.transcriptions.create(model='whisper-1', file=f)
r3 = client.audio.transcriptions.create(model="gpt-4o-transcribe", file=f)
r4 = client.audio.transcriptions.create(model='gpt-4o-transcribe', file=f)
r5 = client.audio.transcriptions.create(model="gpt-4o-mini-transcribe", file=f)
r6 = client.audio.transcriptions.create(model='gpt-4o-mini-transcribe', file=f)
r7 = client.audio.transcriptions.create(model="gpt-4o-transcribe-diarize", file=f)
r8 = client.audio.transcriptions.create(model='gpt-4o-transcribe-diarize', file=f)

# Near misses: other names, not part of this shutdown.
near1 = client.audio.transcriptions.create(model="gpt-4o-mini-transcribe-2025-12-15", file=f)
near2 = client.audio.transcriptions.create(model="gpt-transcribe", file=f)
