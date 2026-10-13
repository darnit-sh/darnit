import requests


def speak(text):
    payload = {"model": "tts-1", "input": text}
    return requests.post("https://example.com/v1/speech", json=payload)
