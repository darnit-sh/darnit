from openai import OpenAI

client = OpenAI()


def summarize(text: str) -> str:
    res = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": text}],
        max_tokens=128,
    )
    return res.choices[0].message.content
