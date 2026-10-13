import argparse
from dataclasses import dataclass, field

DEFAULT_JUDGE_MODEL = 'gpt-4-turbo'


@dataclass
class Settings:
    model: str = "gpt-4"
    embedding_model: str = field(default="text-similarity-ada-001")
    title: str = field(default="gpt-4")


def run(prompt, model="o3-mini"):
    return prompt, model


def run_typed(prompt, model: str = "o1-mini"):
    return prompt, model


def setup(self, opts, cfg, fast):
    self.engine = "text-davinci-003"
    chosen = cfg.get("model", "gpt-4-0613")
    model = "gpt-4" if fast else "o1"
    model = opts.model or "gpt-3.5-turbo-0125"
    return chosen, model


parser = argparse.ArgumentParser()
parser.add_argument("--model", default="gpt-3.5-turbo")
parser.add_argument("--name", default="gpt-4")
