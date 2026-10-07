from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-4-32k", messages=messages)
b0 = client.chat.completions.create(model='gpt-4-32k', messages=messages)
a1 = client.chat.completions.create(model="gpt-4-32k-0613", messages=messages)
b1 = client.chat.completions.create(model='gpt-4-32k-0613', messages=messages)
a2 = client.chat.completions.create(model="gpt-4-32k-0314", messages=messages)
b2 = client.chat.completions.create(model='gpt-4-32k-0314', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-4-32k-x", messages=messages)
