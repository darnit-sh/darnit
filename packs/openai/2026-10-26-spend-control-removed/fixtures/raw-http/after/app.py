import requests
from openai import OpenAI

client = OpenAI()
requests.post("https://api.openai.com/v1/agents/sessions", json={"spend_control": 1})
requests.post("https://api.openai.com/v1/agents/sessions/sess_1", json={'spend_control': 2})
client.post("/agents/sessions", body={"spend_control": 3}, cast_to=object)
requests.post("https://api.openai.com/v1/agents/sessions", json=dict(spend_control=4))

requests.post("/api/budget", json=dict(spend_control=1))
requests.post("/api/budget", json={"spend_control": 1})
