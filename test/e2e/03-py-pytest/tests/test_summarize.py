from types import SimpleNamespace as NS
from app.summarize import summarize


class FakeCompletions:
    def create(self, **kwargs):
        return NS(choices=[NS(message=NS(content="short"))])


def test_summarize():
    client = NS(chat=NS(completions=FakeCompletions()))
    assert summarize(client, "a long text") == "short"
