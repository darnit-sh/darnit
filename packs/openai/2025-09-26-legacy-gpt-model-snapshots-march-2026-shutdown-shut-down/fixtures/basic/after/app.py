from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-4-0314", messages=messages)
b0 = client.chat.completions.create(model='gpt-4-0314', messages=messages)
a1 = client.chat.completions.create(model="gpt-4-0125-preview", messages=messages)
b1 = client.chat.completions.create(model='gpt-4-0125-preview', messages=messages)
a2 = client.chat.completions.create(model="gpt-4-turbo-preview", messages=messages)
b2 = client.chat.completions.create(model='gpt-4-turbo-preview', messages=messages)
a3 = client.chat.completions.create(model="gpt-4-turbo-preview-completions", messages=messages)
b3 = client.chat.completions.create(model='gpt-4-turbo-preview-completions', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-4-0314-x", messages=messages)
