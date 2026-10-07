from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-3.5-turbo-0301", messages=messages)
b0 = client.chat.completions.create(model='gpt-3.5-turbo-0301', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-3.5-turbo-0301-x", messages=messages)
