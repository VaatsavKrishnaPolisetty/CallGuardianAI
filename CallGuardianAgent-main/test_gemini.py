"""Safe optional live Gemini check plus provider-error classifier unit tests."""

import os
import sys

import pytest
from google import genai

from gemini_config import (
    classify_gemini_error,
    configured_api_key,
    load_project_environment,
)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (genai.errors.ClientError(401, {"error": {"message": "unauthorized"}}), "authentication"),
        (genai.errors.ClientError(401, {"error": {"message": "ACCESS_TOKEN_TYPE_UNSUPPORTED"}}), "authentication_type"),
        (genai.errors.ClientError(403, {"error": {"message": "forbidden"}}), "authentication"),
        (genai.errors.ClientError(429, {"error": {"message": "quota"}}), "quota"),
        (genai.errors.ClientError(404, {"error": {"message": "model not found"}}), "model"),
        (genai.errors.ServerError(503, {"error": {"message": "unavailable"}}), "provider_server"),
        (TimeoutError(), "timeout"),
        (ConnectionError(), "network"),
    ],
)
def test_gemini_error_categories(error, expected):
    category, message = classify_gemini_error(error, "gemini-test")
    assert category == expected
    assert message
    assert "unauthorized" not in message
    assert "quota" not in message.lower() or expected == "quota"


def main() -> int:
    load_project_environment()
    api_key = configured_api_key()
    if not api_key:
        print("GEMINI_API_KEY is missing from the backend environment/project .env.", file=sys.stderr)
        return 2

    model = (os.getenv("GEMINI_MODEL") or "gemini-3.8-flash").strip()
    try:
        client = genai.Client(
            api_key=api_key,
            http_options=genai.types.HttpOptions(timeout=30_000),
        )
        response = client.models.generate_content(
            model=model,
            contents="Reply with exactly: OK",
            config={"max_output_tokens": 8},
        )
        if not response.text or not response.text.strip():
            print(f"Gemini request succeeded but returned empty text (model={model}).", file=sys.stderr)
            return 1
        print(f"Gemini connection succeeded (model={model}; response nonempty).")
        return 0
    except Exception as error:
        category, detail = classify_gemini_error(error, model)
        status = getattr(error, "code", None)
        print(f"Gemini connection failed (category={category}, status={status}): {detail}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
