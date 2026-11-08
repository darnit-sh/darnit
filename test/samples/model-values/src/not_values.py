PRICES = {"gpt-4": 0.03, "o1": 0.15}
MODELS = ["gpt-4", "o1-mini"]
# model = "gpt-4"


def describe(model):
    "gpt-4"
    if model == "gpt-4":
        return "old"
    return model


MODEL_FAST = "gpt-test-model"
NEWER_MODEL = "gpt-test-model"
mini = ChatOpenAI(model="gpt-test-model")
label = "gpt-4"
