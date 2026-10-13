import tiktoken

tokenizer_model = "gpt-4"
enc = tiktoken.encoding_for_model("gpt-4")
counter = get_tokenizer(model="gpt-4")


def count_tokens(text, model="gpt-4"):
    return len(text)
