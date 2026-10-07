from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-5.2-chat-latest", messages=messages)
b0 = client.chat.completions.create(model='gpt-5.2-chat-latest', messages=messages)
a1 = client.chat.completions.create(model="gpt-5.3-chat-latest", messages=messages)
b1 = client.chat.completions.create(model='gpt-5.3-chat-latest', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-5.2-chat-latest-x", messages=messages)
