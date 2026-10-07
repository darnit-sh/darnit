from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-image-1-mini", messages=messages)
b0 = client.chat.completions.create(model='gpt-image-1-mini', messages=messages)
a1 = client.chat.completions.create(model="gpt-image-1.5", messages=messages)
b1 = client.chat.completions.create(model='gpt-image-1.5', messages=messages)
a2 = client.chat.completions.create(model="chatgpt-image-latest", messages=messages)
b2 = client.chat.completions.create(model='chatgpt-image-latest', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-image-1-mini-x", messages=messages)
