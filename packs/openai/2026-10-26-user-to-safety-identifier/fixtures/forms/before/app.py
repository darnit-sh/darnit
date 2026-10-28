import requests
from openai import OpenAI

client = OpenAI()
client.images.generate(prompt="x", user="u1")
client.images.with_raw_response.generate(prompt="x", user="u1")
client.images.with_raw_response.edit(image=f, prompt="x", user="u1")
client.images.with_streaming_response.generate(prompt="x", user="u1")
client.images.with_streaming_response.edit(image=f, prompt="x", user="u1")
requests.post("https://api.openai.com/v1/images/generations", json={"prompt": "x", "user": "u1"})

save(user="u1")
requests.post("/api/profile", json={"user": "u1"})
