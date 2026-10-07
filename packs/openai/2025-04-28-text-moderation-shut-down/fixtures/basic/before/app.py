from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="text-moderation-007", messages=messages)
b0 = client.chat.completions.create(model='text-moderation-007', messages=messages)
a1 = client.chat.completions.create(model="text-moderation-stable", messages=messages)
b1 = client.chat.completions.create(model='text-moderation-stable', messages=messages)
a2 = client.chat.completions.create(model="text-moderation-latest", messages=messages)
b2 = client.chat.completions.create(model='text-moderation-latest', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="text-moderation-007-x", messages=messages)
