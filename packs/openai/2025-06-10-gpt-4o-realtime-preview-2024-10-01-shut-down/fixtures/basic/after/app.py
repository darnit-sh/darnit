from openai import OpenAI

client = OpenAI()

a0 = client.chat.completions.create(model="gpt-4o-realtime-preview-2024-10-01", messages=messages)
b0 = client.chat.completions.create(model='gpt-4o-realtime-preview-2024-10-01', messages=messages)

# Near miss: a longer name is a different model.
near = client.chat.completions.create(model="gpt-4o-realtime-preview-2024-10-01-x", messages=messages)
