PRICES = {"gpt-4": 0.03, "o1": 0.15}
MODELS = ["gpt-4", "o1-mini"]
# model = "gpt-4"


def describe(model):
    "gpt-4"
    if model == "gpt-4":
        return "old"
    return model


MODEL_FAST = "gpt-4o"
NEWER_MODEL = "gpt-4.1"
mini = ChatOpenAI(model="gpt-4o-mini")
label = "gpt-4"
