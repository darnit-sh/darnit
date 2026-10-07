from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-4-vision-preview", messages=messages)
b0 = client.chat.completions.create(model='gpt-4-vision-preview', messages=messages)
a1 = client.chat.completions.create(model="gpt-4-1106-vision-preview", messages=messages)
b1 = client.chat.completions.create(model='gpt-4-1106-vision-preview', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-4-vision-preview-x", messages=messages)
