# ==========================================
# CallGuardianAI — Production Dockerfile
# Optimized for Railway, Fly.io, and Cloud Containers
# ==========================================

FROM python:3.12-slim

# Set environment defaults
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8001 \
    CALLGUARDIAN_DB_PATH=/data/callguardian.db

WORKDIR /app

# Install system dependencies if required
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code and frontend assets
COPY . .

# Create persistent data volume mount point
RUN mkdir -p /data

EXPOSE 8001

# Run with shell syntax so $PORT environment variable is dynamically evaluated
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8001} --workers 1"]
