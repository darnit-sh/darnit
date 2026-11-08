def summarize(client, text):
    res = client.chat.completions.create(
        model="gpt-6-luna",
        messages=[{"role": "user", "content": f"Summarize: {text}"}],
        max_tokens=256,
    )
    return res.choices[0].message.content
