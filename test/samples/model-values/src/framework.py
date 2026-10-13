from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-3.5-turbo", temperature=0)
agent = Agent(model_name="gpt-4")
chained = ChatOpenAI(model="gpt-4", max_tokens=500).bind_tools(tools)
