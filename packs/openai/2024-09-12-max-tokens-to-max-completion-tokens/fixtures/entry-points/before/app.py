from openai import OpenAI

client = OpenAI()

# Every chat completions entry point takes the same arguments.
parsed = client.chat.completions.parse(model="gpt-4o", messages=[], max_tokens=100)
streamed = client.chat.completions.stream(model="gpt-4o", messages=[], max_tokens=100)
raw = client.chat.completions.with_raw_response.create(model="gpt-4o", messages=[], max_tokens=100)
chunks = client.chat.completions.with_streaming_response.create(model="gpt-4o", messages=[], max_tokens=100)
beta = client.beta.chat.completions.parse(model="gpt-4o", messages=[], max_tokens=100)

# Legacy completions keep max_tokens; it is not deprecated there.
legacy = client.completions.create(model="gpt-3.5-turbo-instruct", prompt="hi", max_tokens=100)

# A chain broken across lines is the same call.
multiline = (client.chat.completions
    .create(model="gpt-4o", messages=[], max_tokens=100))
