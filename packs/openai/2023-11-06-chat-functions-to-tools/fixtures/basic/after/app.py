from openai import OpenAI

client = OpenAI()


def ask(messages, schema):
    res = client.chat.completions.create(
        model="gpt-4",
        messages=messages,
        functions=[{"name": "get_weather", "description": "Current weather", "parameters": schema}],
        function_call="auto",
    )
    return res.choices[0].message
