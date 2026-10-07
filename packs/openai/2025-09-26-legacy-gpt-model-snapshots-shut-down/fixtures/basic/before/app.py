from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-3.5-turbo-instruct", messages=messages)
b0 = client.chat.completions.create(model='gpt-3.5-turbo-instruct', messages=messages)
a1 = client.chat.completions.create(model="babbage-002", messages=messages)
b1 = client.chat.completions.create(model='babbage-002', messages=messages)
a2 = client.chat.completions.create(model="davinci-002", messages=messages)
b2 = client.chat.completions.create(model='davinci-002', messages=messages)
a3 = client.chat.completions.create(model="gpt-3.5-turbo-1106", messages=messages)
b3 = client.chat.completions.create(model='gpt-3.5-turbo-1106', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-3.5-turbo-instruct-x", messages=messages)
