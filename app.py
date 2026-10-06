from openai import OpenAI

client = OpenAI()


def summarize(messages):
    res = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        max_tokens=256,
    )
    return res.choices[0].message.content
