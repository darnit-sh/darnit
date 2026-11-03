from openai import AsyncOpenAI, OpenAI

client = OpenAI()

a = client.audio.translations.create(file=f, model="whisper-1")
b = client.audio.translations.create(file=f, model=model)
c = client.audio.translations.with_raw_response.create(file=f, model="whisper-1")
with client.audio.translations.with_streaming_response.create(file=f, model="whisper-1") as d:
    pass


async def translate(f):
    return await AsyncOpenAI().audio.translations.create(file=f, model="whisper-1")


# Near misses: transcriptions stay, and realtime translations is the replacement.
near = client.audio.transcriptions.create(file=f, model="gpt-transcribe")
following = client.realtime.translations.client_secrets.create()
