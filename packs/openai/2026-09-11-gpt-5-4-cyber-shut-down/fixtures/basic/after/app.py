from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-5.4-cyber", messages=messages)
b0 = client.chat.completions.create(model='gpt-5.4-cyber', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-5.4-cyber-x", messages=messages)
