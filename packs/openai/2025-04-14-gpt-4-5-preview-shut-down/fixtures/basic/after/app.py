from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-4.5-preview", messages=messages)
b0 = client.chat.completions.create(model='gpt-4.5-preview', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-4.5-preview-x", messages=messages)
