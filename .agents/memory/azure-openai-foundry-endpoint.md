---
name: Azure OpenAI / AI Foundry endpoint shapes
description: How to call Azure chat completions across Foundry (services.ai.azure.com) vs classic (cognitiveservices.azure.com) resources.
---

# Azure OpenAI endpoint shapes

Two different Azure resource types serve OpenAI chat, and they need different URL/body shapes:

- **Azure AI Foundry** host `*.services.ai.azure.com` — speaks the OpenAI-compatible **v1 API**:
  `POST {origin}/openai/v1/chat/completions`, the deployment goes in the request **body** as `model`, and there is **no** `api-version` query param. Auth header `api-key`.
- **Classic Azure OpenAI** host `*.cognitiveservices.azure.com` — uses the **deployments path**:
  `POST {origin}/openai/deployments/{deployment}/chat/completions?api-version=YYYY-MM-DD`, no `model` in body. Auth header `api-key`.

**Why:** users often paste the *full* endpoint URL from the Azure portal (e.g. the Foundry `.../openai/v1/responses` URL), not just the origin. Concatenating paths onto that produces a malformed URL and a misleading `404 Resource not found`. A wrong deployment name on an otherwise-valid resource gives `404 DeploymentNotFound` instead — these two 404s mean different things.

**How to apply:** always reduce a configured endpoint to `new URL(ep).origin` and rebuild the path. Pick v1 vs classic by host suffix (or `/openai/v1/` in the pasted URL). Do **not** borrow the realtime `AZURE_VOICE_LIVE_MODEL` as the chat deployment — the dedicated chat resource may not host it (the EY Foundry resource hosts `gpt-4o-mini`, not full `gpt-4o`). `response_format: {type:"json_object"}` works on the Foundry v1 path.
