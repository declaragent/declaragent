/**
 * Fetch the standard OpenAI-style `GET <baseURL>/models` endpoint.
 * Most openai-compat backends implement this (OpenAI, Groq, Together, Mistral,
 * Ollama, LM Studio, etc.). The shape is `{ data: [{ id, ... }] }`.
 */

export interface OpenAIListedModel {
  id: string;
  description?: string;
}

export async function fetchOpenAICompatModels(
  baseURL: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenAIListedModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(`${baseURL}/models`, { headers });
  if (!response.ok) {
    throw new Error(`models fetch failed (${response.status}): ${response.statusText}`);
  }
  const body = (await response.json()) as { data?: OpenAIListedModel[] };
  return body.data ?? [];
}
