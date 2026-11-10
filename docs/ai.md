# Smart categories and AI

## How categories are suggested

the app suggests categories from the ones you've picked before, for money in and money out separately. When you set one, choose what happens to that payee: always that category (its other transactions waiting for review are done too, and new ones need no review), ask each time, or always review it yourself (for e-transfers and transfers that can be several things). Ledger settings → Payees lists your choices. New payees can go to an LLM of your choice (a primary provider and a fallback, both optional), and its suggestions wait for your review.

## AI providers

AI is off until you add a provider in **App settings → AI** (or through the env vars above):

- **Hosted:** Claude (Anthropic), OpenAI, OpenRouter, Google Gemini, Mistral, Groq, DeepSeek or xAI. Pick the provider, a model (e.g. `claude-opus-5-5`, or `claude-haiku-4-5` for lower cost) and your API key. The URL is built in.
- **Sign in with ChatGPT:** choose *OpenAI (sign in with ChatGPT)* and **Continue with ChatGPT** to use your ChatGPT plan instead of an API key. Requests count toward your plan's usage. OpenAI sends you back to `http://127.0.0.1:<the server's port>/auth/callback`, which finishes it on its own when your browser is on the same machine as the server. Otherwise, copy the address of the page you end on and paste it into the form. This one is set up in the app only, not through the env vars.
- **Local LLM:** an [Ollama](https://ollama.com) server, no key needed. It's at `localhost:11434` unless you give a URL. When this app runs in Docker and Ollama on the same computer, give `http://host.docker.internal:11434/v1`. Pick a model that answers quickly without thinking first: on a Mac with 32 GB, `gemma4:26b` (a mixture-of-experts model, about 17 GB) or `gemma4:12b` for less memory. The app asks local servers not to think, and steps down to plain JSON when the model can't do structured output.
- **OpenAI-compatible:** any other server that speaks the OpenAI chat API (LM Studio, vLLM, a gateway, or Ollama on another machine or outside Docker). Changing the URL to another server, or the provider, clears the saved key, so enter it again.

The fallback is optional: set it to *None* to use the primary provider only. Setting the primary provider to *None* turns AI off, and the fallback with it. API keys and the ChatGPT sign-in are stored encrypted with the key in `secret.key`.

Use **Test connection** to check a provider. Only the payee, amount, date, account type, notes and your category names are sent. Account names, numbers and balances never are.
