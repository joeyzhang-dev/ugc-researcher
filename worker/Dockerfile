# Image for the two always-on Discord workers (see fly.toml [processes]).
# The transcription worker is NOT hosted — it stays on Joey's Mac, which is why
# requirements-hosted.txt exists instead of requirements.txt.
FROM python:3.12-slim

# Logs must stream to `fly logs` rather than sit in a block buffer; both workers
# print progress lines with flush=True but discord.py's logging does not.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY worker/requirements-hosted.txt ./worker/requirements-hosted.txt
RUN pip install --no-cache-dir -r worker/requirements-hosted.txt

COPY worker/ ./worker/

# Neither process needs to write to the filesystem or bind a port.
RUN useradd --create-home --uid 10001 worker && chown -R worker:worker /app
USER worker

# No CMD: fly.toml's [processes] supplies the command per machine group.
