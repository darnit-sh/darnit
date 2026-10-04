def summarize(client, text):
    res = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": f"Summarize: {text}"}],
        max_tokens=256,
    )
    return res.choices[0].message.content
