from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="code-davinci-001", messages=messages)
b0 = client.chat.completions.create(model='code-davinci-001', messages=messages)
a1 = client.chat.completions.create(model="code-cushman-002", messages=messages)
b1 = client.chat.completions.create(model='code-cushman-002', messages=messages)
a2 = client.chat.completions.create(model="code-cushman-001", messages=messages)
b2 = client.chat.completions.create(model='code-cushman-001', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="code-davinci-001-x", messages=messages)
