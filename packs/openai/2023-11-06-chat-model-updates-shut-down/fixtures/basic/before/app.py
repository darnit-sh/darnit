from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-3.5-turbo-0613", messages=messages)
b0 = client.chat.completions.create(model='gpt-3.5-turbo-0613', messages=messages)
a1 = client.chat.completions.create(model="gpt-3.5-turbo-16k-0613", messages=messages)
b1 = client.chat.completions.create(model='gpt-3.5-turbo-16k-0613', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-3.5-turbo-0613-x", messages=messages)
