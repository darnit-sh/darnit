from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="dall-e-2", messages=messages)
b0 = client.chat.completions.create(model='dall-e-2', messages=messages)
a1 = client.chat.completions.create(model="dall-e-3", messages=messages)
b1 = client.chat.completions.create(model='dall-e-3', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="dall-e-2-x", messages=messages)
