from openai import OpenAI

client = OpenAI()

client.chat.completions.create(model="o1", max_tokens=  # cap for cost
    500, messages=[])
client.chat.completions.create(model="o1", max_tokens  # cap
    =500, messages=[])
