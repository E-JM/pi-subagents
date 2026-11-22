---
name: test-interactive-invalid
description: Invalid agent — autonomous (spawning: false) that illegally declares interactive: true
model: anthropic/claude-haiku-4-5
spawning: false
interactive: true
disable-model-invocation: true
---

You are a test agent. This configuration is invalid: spawning: false with
interactive: true must be rejected at spawn time. If you are running, the
validation failed.
