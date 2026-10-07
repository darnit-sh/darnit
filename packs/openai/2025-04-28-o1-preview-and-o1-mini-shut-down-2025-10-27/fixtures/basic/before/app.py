from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="o1-mini", messages=messages)
b0 = client.chat.completions.create(model='o1-mini', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="o1-mini-x", messages=messages)
