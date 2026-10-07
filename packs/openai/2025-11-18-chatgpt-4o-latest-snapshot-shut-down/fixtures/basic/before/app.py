from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="chatgpt-4o-latest", messages=messages)
b0 = client.chat.completions.create(model='chatgpt-4o-latest', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="chatgpt-4o-latest-x", messages=messages)
